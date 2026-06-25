const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { validarSenhaAutorizacao } = require('../middleware/autorizacao')

// Quem pode abrir/fechar o caixa
const ADM = exigirPerfil('proprietario', 'gerente', 'caixa')

function unidadeDoUsuario(req) {
  return req.usuario.unidade_id || null
}

// ============================================================
// GET /caixa/status  -> sessão aberta da unidade (ou null)
// ============================================================
router.get('/status', autenticar, async (req, res) => {
  try {
    const unidade = unidadeDoUsuario(req)
    let q = supabaseAdmin.from('caixa_sessoes')
      .select('*').eq('status', 'aberto')
      .order('aberto_em', { ascending: false }).limit(1)
    if (unidade) q = q.eq('unidade_id', unidade)
    const { data, error } = await q
    if (error) throw error
    const sessao = (data && data[0]) || null
    return res.json({ aberto: !!sessao, sessao })
  } catch (err) {
    console.error('[caixa/status]', err.message)
    return res.status(500).json({ erro: err.message })
  }
})

// ============================================================
// POST /caixa/abrir  { saldo_inicial }
// ============================================================
router.post('/abrir', autenticar, ADM, async (req, res) => {
  try {
    const unidade = unidadeDoUsuario(req)

    // Já existe caixa aberto para esta unidade?
    let qExist = supabaseAdmin.from('caixa_sessoes').select('id').eq('status', 'aberto').limit(1)
    if (unidade) qExist = qExist.eq('unidade_id', unidade)
    const { data: jaAberto } = await qExist
    if (jaAberto && jaAberto.length) {
      return res.status(409).json({ erro: 'O caixa já está aberto.' })
    }

    const saldo = parseFloat(req.body.saldo_inicial) || 0
    const { data, error } = await supabaseAdmin.from('caixa_sessoes').insert({
      unidade_id:      unidade,
      status:          'aberto',
      saldo_inicial:   saldo,
      aberto_por:      req.usuario.id,
      aberto_por_nome: req.usuario.nome || null,
    }).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    // corrida: o índice único pegou outra abertura simultânea
    if (err && (err.code === '23505' || /duplicate key/i.test(err.message || ''))) {
      return res.status(409).json({ erro: 'O caixa já está aberto.' })
    }
    console.error('[caixa/abrir]', err.message)
    return res.status(500).json({ erro: err.message })
  }
})

// ============================================================
// POST /caixa/fechar  { dinheiro, obs }
// ============================================================
router.post('/fechar', autenticar, ADM, async (req, res) => {
  try {
    const unidade = unidadeDoUsuario(req)

    let q = supabaseAdmin.from('caixa_sessoes')
      .select('*').eq('status', 'aberto')
      .order('aberto_em', { ascending: false }).limit(1)
    if (unidade) q = q.eq('unidade_id', unidade)
    const { data: abertos } = await q
    if (!abertos || !abertos.length) {
      return res.status(409).json({ erro: 'Não há caixa aberto para fechar.' })
    }
    const sessao = abertos[0]

    // Faturamento do período (comandas finalizadas desde a abertura)
    let qc = supabaseAdmin.from('comandas')
      .select('total').eq('status', 'finalizada')
      .gte('finalizada_em', sessao.aberto_em)
    if (unidade) qc = qc.eq('unidade_id', unidade)
    const { data: comandas } = await qc
    const faturamento = (comandas || []).reduce((s, c) => s + (parseFloat(c.total) || 0), 0)

    const dinheiro = (req.body.dinheiro != null && req.body.dinheiro !== '')
      ? (parseFloat(req.body.dinheiro) || 0) : null

    const { data, error } = await supabaseAdmin.from('caixa_sessoes').update({
      status:           'fechado',
      fechado_em:       new Date().toISOString(),
      fechado_por:      req.usuario.id,
      fechado_por_nome: req.usuario.nome || null,
      dinheiro_conferido: dinheiro,
      faturamento:      faturamento,
      observacao:       req.body.obs || null,
    }).eq('id', sessao.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[caixa/fechar]', err.message)
    return res.status(500).json({ erro: err.message })
  }
})

// ============================================================
// POST /caixa/retirada  — saída/sangria do caixa
//   Caixa pode lançar, mas precisa da senha de autorização.
//   Gerente/proprietário logado autoriza sozinho.
// ============================================================
router.post('/retirada', autenticar, ADM, async (req, res) => {
  try {
    const unidade = unidadeDoUsuario(req)
    const valor = parseFloat(req.body.valor)
    if (!valor || valor <= 0) {
      return res.status(400).json({ erro: 'Informe um valor válido para a saída.' })
    }

    // Autorização: gestor logado OU senha de autorização válida
    let autorizador = null
    if (['gerente', 'proprietario'].includes(req.usuario.perfil)) {
      autorizador = { id: req.usuario.id, nome: req.usuario.nome }
    } else {
      autorizador = await validarSenhaAutorizacao(req.body.senha)
      if (!autorizador) return res.status(403).json({ erro: 'Senha de autorização inválida.' })
    }

    // Sessão de caixa aberta da unidade (se houver)
    let q = supabaseAdmin.from('caixa_sessoes').select('id').eq('status', 'aberto')
      .order('aberto_em', { ascending: false }).limit(1)
    if (unidade) q = q.eq('unidade_id', unidade)
    const { data: abertos } = await q
    const sessao_id = (abertos && abertos[0]) ? abertos[0].id : null

    // Nome do responsável (quem operou)
    let responsavel_id = req.body.responsavel_id || req.usuario.id
    let responsavel_nome = req.usuario.nome || null
    if (req.body.responsavel_id) {
      const { data: rc } = await supabaseAdmin.from('colaboradores').select('nome').eq('id', req.body.responsavel_id).single()
      if (rc) responsavel_nome = rc.nome
    }

    const motivo = [req.body.motivo, req.body.descricao].filter(Boolean).join(' — ')

    const { data, error } = await supabaseAdmin.from('caixa_retiradas').insert({
      sessao_id,
      unidade_id:          unidade,
      valor,
      motivo:              motivo || null,
      responsavel_id,
      responsavel_nome,
      autorizado_por:      autorizador.id,
      autorizado_por_nome: autorizador.nome,
    }).select().single()
    if (error) throw error

    return res.status(201).json({ ok: true, autorizado_por: autorizador.nome, retirada: data })
  } catch (err) {
    console.error('[caixa/retirada]', err.message)
    return res.status(500).json({ erro: err.message })
  }
})

// ============================================================
// GET /caixa/retiradas — saídas da sessão aberta (ou do dia) da unidade
// ============================================================
router.get('/retiradas', autenticar, ADM, async (req, res) => {
  try {
    const unidade = unidadeDoUsuario(req)

    // Sessão aberta da unidade (se houver)
    let qs = supabaseAdmin.from('caixa_sessoes').select('id').eq('status', 'aberto')
      .order('aberto_em', { ascending: false }).limit(1)
    if (unidade) qs = qs.eq('unidade_id', unidade)
    const { data: abertos } = await qs
    const sessao_id = (abertos && abertos[0]) ? abertos[0].id : null

    let q = supabaseAdmin.from('caixa_retiradas').select('*').order('criado_em', { ascending: false })
    if (sessao_id) {
      q = q.eq('sessao_id', sessao_id)
    } else {
      // sem caixa aberto: mostra as de hoje da unidade
      const hoje = new Date()
      const ini = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 0, 0, 0).toISOString()
      if (unidade) q = q.eq('unidade_id', unidade)
      q = q.gte('criado_em', ini)
    }
    const { data, error } = await q
    if (error) throw error
    const total = (data || []).reduce((s, r) => s + (parseFloat(r.valor) || 0), 0)
    return res.json({ retiradas: data || [], total })
  } catch (err) {
    console.error('[caixa/retiradas]', err.message)
    return res.status(500).json({ erro: err.message })
  }
})

// ============================================================
// DELETE /caixa/retirada/:id — exclui uma saída (precisa autorização)
// ============================================================
router.delete('/retirada/:id', autenticar, ADM, async (req, res) => {
  try {
    // Autorização: gestor logado OU senha de autorização válida
    let autorizador = null
    if (['gerente', 'proprietario'].includes(req.usuario.perfil)) {
      autorizador = { id: req.usuario.id, nome: req.usuario.nome }
    } else {
      const senha = (req.body && req.body.senha) || req.query.senha
      autorizador = await validarSenhaAutorizacao(senha)
      if (!autorizador) return res.status(403).json({ erro: 'Senha de autorização inválida.' })
    }
    const { error } = await supabaseAdmin.from('caixa_retiradas').delete().eq('id', req.params.id)
    if (error) throw error
    return res.json({ ok: true })
  } catch (err) {
    console.error('[caixa/retirada DELETE]', err.message)
    return res.status(500).json({ erro: err.message })
  }
})

module.exports = router
