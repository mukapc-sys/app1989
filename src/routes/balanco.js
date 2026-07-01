// ============================================================
// balanco.js — Balanço de estoque com aprovação (ITEM 4)
// Caixa/gerente conta e ENVIA; proprietário aprova item a item.
// Montar no server: app.use('/balanco', require('./routes/balanco'))
// ============================================================
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

const { exigirTela, exigirFuncao } = require('./permissoes')
const CONTADOR = exigirPerfil('proprietario', 'gerente', 'caixa') // quem conta/envia
const PROP     = exigirPerfil('proprietario')                     // quem aprova
const TELA_BAL = exigirTela('balanco')

// ---- saldo de estoque (mesma regra do módulo de estoque) ----
function _saldoPorProduto(movs) {
  const s = {}
  for (const m of movs) {
    const q = parseFloat(m.quantidade) || 0
    const neg = String(m.tipo || '').startsWith('saida')
    s[m.produto_id] = (s[m.produto_id] || 0) + (neg ? -q : q)
  }
  return s
}
async function _movimentosUnidade(unidade_id, produto_id) {
  const pageSize = 1000; let from = 0; let all = []
  while (true) {
    let q = supabaseAdmin.from('movimentacoes_estoque')
      .select('produto_id, tipo, quantidade').eq('unidade_id', unidade_id)
    if (produto_id) q = q.eq('produto_id', produto_id)
    const { data, error } = await q.range(from, from + pageSize - 1)
    if (error || !data || data.length === 0) break
    all = all.concat(data)
    if (data.length < pageSize) break
    from += pageSize
    if (from > 200000) break
  }
  return all
}

// unidade do usuário: proprietário pode escolher; gerente/caixa usam a própria
function unidadeDoUsuario(req) {
  if (req.usuario.perfil === 'proprietario') return req.query.unidade_id || req.body.unidade_id || null
  return req.usuario.unidade_id
}

// ------------------------------------------------------------
// GET /balanco/produtos?unidade_id=..
// Lista todos os produtos ativos + saldo do sistema (para a contagem).
// ------------------------------------------------------------
router.get('/produtos', autenticar, CONTADOR, TELA_BAL, async (req, res) => {
  try {
    const unidade_id = unidadeDoUsuario(req)
    if (!unidade_id) return res.status(400).json({ erro: 'Informe a unidade.' })
    const { data: prods } = await supabaseAdmin.from('produtos')
      .select('id, nome, categorias_produto(nome)')
      .eq('ativo', true).order('nome')
    const saldo = _saldoPorProduto(await _movimentosUnidade(unidade_id, null))
    const lista = (prods || []).map(p => ({
      produto_id: p.id,
      nome: p.nome,
      categoria: (p.categorias_produto && p.categorias_produto.nome) || '—',
      saldo_sistema: Math.round(saldo[p.id] || 0),
    }))
    return res.json({ unidade_id, produtos: lista })
  } catch (err) {
    console.error('[balanco/produtos]', err.message)
    return res.status(500).json({ erro: 'Erro ao listar produtos' })
  }
})

// ------------------------------------------------------------
// POST /balanco  { unidade_id, itens:[{produto_id, produto_nome, contagem_fisica}], observacao }
// Cria o balanço (status pendente). Recalcula saldo_sistema no envio. NÃO ajusta nada.
// ------------------------------------------------------------
router.post('/', autenticar, CONTADOR, TELA_BAL, async (req, res) => {
  try {
    const unidade_id = unidadeDoUsuario(req)
    const itens = req.body.itens || []
    if (!unidade_id) return res.status(400).json({ erro: 'Informe a unidade.' })
    if (!itens.length) return res.status(400).json({ erro: 'Envie ao menos um item contado.' })

    // saldo atual do sistema (no momento do envio)
    const saldo = _saldoPorProduto(await _movimentosUnidade(unidade_id, null))

    // cria o cabeçalho
    const { data: bal, error: e1 } = await supabaseAdmin.from('balancos').insert({
      unidade_id, status: 'pendente',
      criado_por: req.usuario.id,
      criado_por_nome: req.usuario.nome || null,
      observacao: req.body.observacao || null,
    }).select().single()
    if (e1) throw e1

    // cria os itens (só os que têm contagem informada)
    const linhas = itens
      .filter(it => it.produto_id && it.contagem_fisica != null && it.contagem_fisica !== '')
      .map(it => {
        const sis = Math.round(saldo[it.produto_id] || 0)
        const fis = Math.round(parseFloat(it.contagem_fisica) || 0)
        return {
          balanco_id: bal.id,
          produto_id: it.produto_id,
          produto_nome: it.produto_nome || null,
          saldo_sistema: sis,
          contagem_fisica: fis,
          diferenca: fis - sis,
          status: 'pendente',
        }
      })
    if (!linhas.length) return res.status(400).json({ erro: 'Nenhuma contagem preenchida.' })

    const { error: e2 } = await supabaseAdmin.from('balanco_itens').insert(linhas)
    if (e2) throw e2

    // TODO WhatsApp: notificar proprietário que há um balanço pendente (semi-pronto).
    try { await notificarProprietarioBalanco(unidade_id, bal.id) } catch (e) {}

    return res.json({ ok: true, balanco_id: bal.id, itens: linhas.length })
  } catch (err) {
    console.error('[balanco POST]', err.message)
    return res.status(500).json({ erro: 'Erro ao enviar balanço: ' + err.message })
  }
})

// ------------------------------------------------------------
// GET /balanco/pendentes  — proprietário: balanços aguardando aprovação
// ------------------------------------------------------------
router.get('/pendentes', autenticar, exigirFuncao('aprovar_balanco'), async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('balancos')
      .select('id, unidade_id, criado_por_nome, criado_em, unidades(nome)')
      .eq('status', 'pendente').order('criado_em', { ascending: false })
    const lista = (data || []).map(b => ({
      id: b.id, unidade_id: b.unidade_id,
      unidade: (b.unidades && b.unidades.nome) || '—',
      criado_por_nome: b.criado_por_nome, criado_em: b.criado_em,
    }))
    return res.json(lista)
  } catch (err) {
    console.error('[balanco/pendentes]', err.message)
    return res.status(500).json({ erro: 'Erro ao listar balanços' })
  }
})

// contagem simples de pendentes (para o card do dashboard)
router.get('/pendentes/contagem', autenticar, exigirFuncao('aprovar_balanco'), async (req, res) => {
  try {
    const { count } = await supabaseAdmin.from('balancos')
      .select('id', { count: 'exact', head: true }).eq('status', 'pendente')
    return res.json({ pendentes: count || 0 })
  } catch (err) {
    return res.json({ pendentes: 0 })
  }
})

// ------------------------------------------------------------
// GET /balanco/:id  — detalhe com itens e diferenças
// ------------------------------------------------------------
router.get('/:id', autenticar, CONTADOR, async (req, res) => {
  try {
    const { data: bal } = await supabaseAdmin.from('balancos')
      .select('*, unidades(nome)').eq('id', req.params.id).single()
    if (!bal) return res.status(404).json({ erro: 'Balanço não encontrado' })
    // gerente/caixa só veem os da própria unidade
    if (req.usuario.perfil !== 'proprietario' && bal.unidade_id !== req.usuario.unidade_id) {
      return res.status(403).json({ erro: 'Sem permissão' })
    }
    const { data: itens } = await supabaseAdmin.from('balanco_itens')
      .select('*').eq('balanco_id', bal.id).order('produto_nome')
    return res.json({
      id: bal.id, unidade_id: bal.unidade_id,
      unidade: (bal.unidades && bal.unidades.nome) || '—',
      status: bal.status, criado_por_nome: bal.criado_por_nome,
      criado_em: bal.criado_em, concluido_em: bal.concluido_em,
      observacao: bal.observacao,
      itens: itens || [],
    })
  } catch (err) {
    console.error('[balanco/:id]', err.message)
    return res.status(500).json({ erro: 'Erro ao abrir balanço' })
  }
})

// ------------------------------------------------------------
// POST /balanco/item/:id/aprovar  — PROP aprova: ajusta o estoque para o físico
// ------------------------------------------------------------
router.post('/item/:id/aprovar', autenticar, exigirFuncao('aprovar_balanco'), async (req, res) => {
  try {
    const { data: item } = await supabaseAdmin.from('balanco_itens')
      .select('*, balancos(unidade_id)').eq('id', req.params.id).single()
    if (!item) return res.status(404).json({ erro: 'Item não encontrado' })
    if (item.status === 'aprovado') return res.json({ ok: true, jaAprovado: true })

    const unidade_id = item.balancos && item.balancos.unidade_id
    const diff = Math.round(parseFloat(item.diferenca) || 0)

    // registra o ajuste no estoque (só se houver diferença)
    if (diff !== 0) {
      const { error: eMov } = await supabaseAdmin.from('movimentacoes_estoque').insert({
        produto_id: item.produto_id, unidade_id, tipo: 'ajuste', quantidade: diff,
        responsavel_id: req.usuario.id,
        observacao: 'Balanço aprovado (de ' + item.saldo_sistema + ' para ' + item.contagem_fisica + ')',
        referencia_id: item.balanco_id,
      })
      if (eMov) throw eMov
    }

    // marca item como aprovado
    await supabaseAdmin.from('balanco_itens')
      .update({ status: 'aprovado', resolvido_por: req.usuario.id, resolvido_em: new Date().toISOString() })
      .eq('id', item.id)

    // se todos os itens do balanço estão aprovados -> conclui o balanço
    const { data: restantes } = await supabaseAdmin.from('balanco_itens')
      .select('id').eq('balanco_id', item.balanco_id).neq('status', 'aprovado')
    let concluido = false
    if (!restantes || restantes.length === 0) {
      await supabaseAdmin.from('balancos')
        .update({ status: 'concluido', concluido_em: new Date().toISOString() })
        .eq('id', item.balanco_id)
      concluido = true
    }
    return res.json({ ok: true, ajuste: diff, balanco_concluido: concluido })
  } catch (err) {
    console.error('[balanco/aprovar]', err.message)
    return res.status(500).json({ erro: 'Erro ao aprovar item: ' + err.message })
  }
})

// ------------------------------------------------------------
// POST /balanco/item/:id/reprovar  — mantém PENDENTE (proprietário decide depois).
// Não ajusta nada; apenas garante que o item continua pendente.
// ------------------------------------------------------------
router.post('/item/:id/reprovar', autenticar, exigirFuncao('aprovar_balanco'), async (req, res) => {
  try {
    const { data: item } = await supabaseAdmin.from('balanco_itens')
      .select('id, status').eq('id', req.params.id).single()
    if (!item) return res.status(404).json({ erro: 'Item não encontrado' })
    // reprovar = deixar pendente (não ajusta). Se já estava aprovado, não desfaz.
    if (item.status !== 'aprovado') {
      await supabaseAdmin.from('balanco_itens')
        .update({ status: 'pendente', resolvido_por: null, resolvido_em: null })
        .eq('id', item.id)
    }
    return res.json({ ok: true, mantido_pendente: true })
  } catch (err) {
    console.error('[balanco/reprovar]', err.message)
    return res.status(500).json({ erro: 'Erro ao reprovar item' })
  }
})

// ------------------------------------------------------------
// WhatsApp (SEMI-PRONTO): notificar proprietário. Finalizar depois.
// Deixa a função pronta para plugar o Evolution API futuramente.
// ------------------------------------------------------------
async function notificarProprietarioBalanco(unidade_id, balanco_id) {
  // TODO: buscar telefone do proprietário e enviar via Evolution API.
  // Padrão já usado no publico.js: EVOLUTION_API_URL / EVOLUTION_API_KEY.
  // Por ora, apenas registra em log — o aviso principal é o card no dashboard.
  console.log('[balanco] Novo balanço pendente', { unidade_id, balanco_id })
  return true
}

module.exports = router
