// ============================================================
// fechamento.js — Fechamento Financeiro (contracheque por colaborador)
// Junta: comissão do período (serviços + produtos) − vales (adiantamento + produtos)
// Emitir = salva o fechamento, QUITA os vales do período e abate o saldo do barbeiro.
// Montar no server: app.use('/fechamento', require('./routes/fechamento'))
// ============================================================
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { calcularComissaoFaixa } = require('./comissao-faixa')

const GESTOR = exigirPerfil('proprietario', 'gerente')

function round(n) { return Math.round((parseFloat(n) || 0) * 100) / 100 }

// monta ini/fim (timestamptz SP) a partir de duas datas AAAA-MM-DD
function intervalo(iniStr, fimStr) {
  const ini = iniStr + 'T00:00:00-03:00'
  const fim = fimStr + 'T23:59:59-03:00'
  return { ini, fim }
}

// Busca comissão de UM colaborador no período (reaproveita o motor oficial)
async function comissaoColaborador(colaborador_id, ini, fim, unidade_id) {
  const r = await calcularComissaoFaixa({ ini, fim, unidade_id })
  const linha = (r.linhas || []).find(l => String(l.colaborador_id) === String(colaborador_id))
  return linha || {
    colaborador_id, nome: '—', atendimentos: 0,
    servico_total: 0, servico_pct: 0, servico_comissao: 0,
    produto_total: 0, produto_pct: 0, produto_comissao: 0,
    comissao_total: 0
  }
}

// Busca os vales do colaborador no período que AINDA não foram quitados
async function valesDoPeriodo(colaborador_id, iniStr, fimStr) {
  const iniTs = iniStr + 'T00:00:00-03:00'
  const fimTs = fimStr + 'T23:59:59-03:00'

  // PIX / dinheiro (adiantamentos)
  const { data: pix } = await supabaseAdmin.from('vales_pix')
    .select('id, valor, descricao, criado_em, status, fechamento_id')
    .eq('colaborador_id', colaborador_id)
    .gte('criado_em', iniTs).lte('criado_em', fimTs)
    .is('fechamento_id', null)
    .order('criado_em', { ascending: true })

  // vale produtos (consumo bar)
  const { data: prod } = await supabaseAdmin.from('vales')
    .select('id, valor, itens, criado_em, status, fechamento_id')
    .eq('colaborador_id', colaborador_id)
    .gte('criado_em', iniTs).lte('criado_em', fimTs)
    .is('fechamento_id', null)
    .order('criado_em', { ascending: true })

  const lpix = (pix || []).filter(v => v.status !== 'quitado')
  const lprod = (prod || []).filter(v => v.status !== 'quitado')

  return {
    adiantamentos: lpix,
    produtos: lprod,
    total_adiantamento: round(lpix.reduce((s, v) => s + (parseFloat(v.valor) || 0), 0)),
    total_produtos:     round(lprod.reduce((s, v) => s + (parseFloat(v.valor) || 0), 0)),
  }
}

// monta o objeto completo do contracheque (sem salvar)
// Prêmio de gestão: % sobre o faturamento TOTAL da unidade no período.
// 5% se a unidade bateu a meta de faturamento do mês, senão 3%.
// Divisão: subgerentes 25% (rateado) / gerentes 75% (rateado). Sem subgerente → gerente 100%.
// Só para perfil 'gerente' (subgerente é gerente com is_subgerente=true).
async function premioGestao(colab, ini, fim, mes) {
  if (colab.perfil !== 'gerente' || !colab.unidade_id) return null
  // faturamento total da unidade no período (comandas finalizadas — inclui tudo)
  const { data: cmds } = await supabaseAdmin.from('comandas')
    .select('total').eq('status', 'finalizada').eq('unidade_id', colab.unidade_id)
    .gte('finalizada_em', ini).lte('finalizada_em', fim)
  const unitFat = (cmds || []).reduce((s, c) => s + (parseFloat(c.total) || 0), 0)
  // meta de faturamento da unidade no mês
  const { data: metaU } = await supabaseAdmin.from('metas_unidade')
    .select('faturamento').eq('unidade_id', colab.unidade_id).eq('mes', mes).maybeSingle()
  const metaFat = parseFloat(metaU && metaU.faturamento) || 0
  const bateu = metaFat > 0 && unitFat >= metaFat
  const pct = bateu ? 0.05 : 0.03
  const premioUnidade = unitFat * pct
  // gestores ativos da unidade
  const { data: gestores } = await supabaseAdmin.from('colaboradores')
    .select('id, is_subgerente').eq('perfil', 'gerente').eq('unidade_id', colab.unidade_id).eq('ativo', true)
  const nSub = (gestores || []).filter(g => g.is_subgerente).length
  const nGer = (gestores || []).filter(g => !g.is_subgerente).length
  let valor = 0
  if (colab.is_subgerente) {
    valor = nSub > 0 ? (premioUnidade * 0.25 / nSub) : 0
  } else {
    const pool = nSub > 0 ? 0.75 : 1.0   // sem subgerente, o gerente leva 100%
    valor = nGer > 0 ? (premioUnidade * pool / nGer) : 0
  }
  return {
    unidade_faturamento: round(unitFat),
    unidade_meta: round(metaFat),
    bateu_meta: bateu,
    pct_premio: pct,
    premio_unidade: round(premioUnidade),
    is_subgerente: !!colab.is_subgerente,
    valor: round(valor),
  }
}

async function montarFechamento(colaborador_id, iniStr, fimStr) {
  // unidade do colaborador
  const { data: colab } = await supabaseAdmin.from('colaboradores')
    .select('id, nome, perfil, salario, unidade_id, saldo_vales_pix, is_subgerente, unidades(nome)')
    .eq('id', colaborador_id).single()
  if (!colab) return null

  const ehFuncionario = (colab.perfil === 'funcionario')

  const { ini, fim } = intervalo(iniStr, fimStr)
  const vales = await valesDoPeriodo(colaborador_id, iniStr, fimStr)

  // Funcionário não comissionado: bruto = salário. Barbeiro: bruto = comissão.
  let com, comissao_bruta, salario
  if (ehFuncionario) {
    salario = round(colab.salario)
    comissao_bruta = salario  // "bruto" do contracheque é o salário
    com = { servico_total:0, servico_pct:0, servico_comissao:0, produto_total:0, produto_pct:0, produto_comissao:0, atendimentos:0 }
  } else {
    com = await comissaoColaborador(colaborador_id, ini, fim, colab.unidade_id)
    salario = 0
    comissao_bruta = round(com.servico_comissao + com.produto_comissao)
  }

  const total_descontos  = round(vales.total_adiantamento + vales.total_produtos)
  // prêmio de gestão (só gerente/subgerente) — soma ao líquido
  const premio = ehFuncionario ? null : await premioGestao(colab, ini, fim, String(iniStr).slice(0, 7))
  const premio_gestao = premio ? premio.valor : 0
  const liquido          = round(comissao_bruta + premio_gestao - total_descontos)

  return {
    colaborador_id,
    colaborador_nome: colab.nome,
    eh_funcionario: ehFuncionario,
    salario: salario,
    unidade_id: colab.unidade_id,
    unidade_nome: (colab.unidades && colab.unidades.nome) || '',
    periodo_ini: iniStr,
    periodo_fim: fimStr,
    saldo_vales_atual: round(colab.saldo_vales_pix),

    servico_total:    round(com.servico_total),
    servico_pct:      com.servico_pct || 0,
    servico_comissao: round(com.servico_comissao),
    produto_total:    round(com.produto_total),
    produto_pct:      com.produto_pct || 0,
    produto_comissao: round(com.produto_comissao),
    atendimentos:     com.atendimentos || 0,
    comissao_bruta,

    vales_adiantamento: vales.total_adiantamento,
    vales_produtos:     vales.total_produtos,
    lista_adiantamentos: vales.adiantamentos,
    lista_vale_produtos: vales.produtos,
    total_descontos,

    premio_gestao,
    premio_detalhe: premio,

    liquido,
  }
}

// ------------------------------------------------------------
// GET /fechamento/previa?colaborador_id=..&ini=AAAA-MM-DD&fim=AAAA-MM-DD
// Calcula e mostra, SEM salvar nem quitar.
// ------------------------------------------------------------
router.get('/previa', autenticar, GESTOR, async (req, res) => {
  try {
    const { colaborador_id, ini, fim } = req.query
    if (!colaborador_id || !ini || !fim) return res.status(400).json({ erro: 'Informe colaborador_id, ini e fim (AAAA-MM-DD).' })
    const f = await montarFechamento(colaborador_id, ini, fim)
    if (!f) return res.status(404).json({ erro: 'Colaborador não encontrado' })
    return res.json(f)
  } catch (err) {
    console.error('[fechamento/previa]', err.message)
    return res.status(500).json({ erro: 'Erro ao montar prévia: ' + err.message })
  }
})

// ------------------------------------------------------------
// POST /fechamento/emitir  { colaborador_id, ini, fim }
// Salva o fechamento, QUITA os vales do período e abate o saldo.
// ------------------------------------------------------------
router.post('/emitir', autenticar, GESTOR, async (req, res) => {
  try {
    const { colaborador_id, ini, fim } = req.body
    if (!colaborador_id || !ini || !fim) return res.status(400).json({ erro: 'Informe colaborador_id, ini e fim.' })

    const f = await montarFechamento(colaborador_id, ini, fim)
    if (!f) return res.status(404).json({ erro: 'Colaborador não encontrado' })

    // 1) salva o fechamento (snapshot)
    const { data: fech, error: eFech } = await supabaseAdmin.from('fechamentos').insert({
      colaborador_id,
      unidade_id:        f.unidade_id,
      periodo_ini:       f.periodo_ini,
      periodo_fim:       f.periodo_fim,
      servico_total:     f.servico_total,
      servico_pct:       f.servico_pct,
      servico_comissao:  f.servico_comissao,
      produto_total:     f.produto_total,
      produto_pct:       f.produto_pct,
      produto_comissao:  f.produto_comissao,
      comissao_bruta:    f.comissao_bruta,
      vales_adiantamento:f.vales_adiantamento,
      vales_produtos:    f.vales_produtos,
      total_descontos:   f.total_descontos,
      liquido:           f.liquido,
      detalhe:           f,
      emitido_por:       req.usuario.id,
    }).select().single()
    if (eFech) throw eFech

    // 2) quita os vales do período (marca status + liga ao fechamento)
    const idsPix  = (f.lista_adiantamentos || []).map(v => v.id)
    const idsProd = (f.lista_vale_produtos || []).map(v => v.id)
    if (idsPix.length) {
      await supabaseAdmin.from('vales_pix')
        .update({ status: 'quitado', fechamento_id: fech.id }).in('id', idsPix)
    }
    if (idsProd.length) {
      await supabaseAdmin.from('vales')
        .update({ status: 'quitado', fechamento_id: fech.id }).in('id', idsProd)
    }

    // 3) abate o saldo de vales do colaborador (não deixa contar de novo)
    try {
      const { data: colab } = await supabaseAdmin.from('colaboradores')
        .select('saldo_vales_pix').eq('id', colaborador_id).single()
      const novo = round((parseFloat(colab.saldo_vales_pix) || 0) - f.total_descontos)
      await supabaseAdmin.from('colaboradores')
        .update({ saldo_vales_pix: novo < 0 ? 0 : novo }).eq('id', colaborador_id)
    } catch (e) { console.error('[fechamento] saldo:', e.message) }

    return res.status(201).json({ ok: true, fechamento_id: fech.id, ...f })
  } catch (err) {
    console.error('[fechamento/emitir]', err.message)
    return res.status(500).json({ erro: 'Erro ao emitir fechamento: ' + err.message })
  }
})

// ------------------------------------------------------------
// GET /fechamento/historico?colaborador_id=..  (lista emitidos)
// ------------------------------------------------------------
router.get('/historico', autenticar, GESTOR, async (req, res) => {
  try {
    let q = supabaseAdmin.from('fechamentos')
      .select('*, colaboradores(nome)')
      .order('criado_em', { ascending: false }).limit(200)
    if (req.query.colaborador_id) q = q.eq('colaborador_id', req.query.colaborador_id)
    const { data } = await q
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar histórico' })
  }
})

module.exports = router
