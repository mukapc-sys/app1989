const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

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

module.exports = router
