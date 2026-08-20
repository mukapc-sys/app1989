// ============================================================
// metas.js — Metas mensais (ITEM 12)
// Proprietário cadastra meta da UNIDADE; gerente distribui por COLABORADOR.
// Progresso puxado dos dados reais (comandas finalizadas do mês).
// Montar no server: app.use('/metas', require('./routes/metas'))
// ============================================================
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { exigirTela } = require('./permissoes')

const GESTOR = exigirPerfil('proprietario', 'gerente')
const PROP   = exigirPerfil('proprietario')
const TELA_METAS = exigirTela('metas')

function round(n) { return Math.round((parseFloat(n) || 0) * 100) / 100 }
function mesAtual() { return new Date(Date.now() - 3*3600*1000).toISOString().slice(0,7) }

// intervalo do mês 'AAAA-MM' em timestamptz SP
function rangeMes(mes) {
  const [y, m] = mes.split('-').map(Number)
  const prox = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`
  return { ini: `${mes}-01T00:00:00-03:00`, fim: `${prox}-01T00:00:00-03:00` }
}

// dias úteis restantes no mês (exclui os dias em que a barbearia fecha)
// FECHA_DIAS: dias da semana fechados (0=domingo..6=sábado).
const FECHA_DIAS = [0] // fecha domingo
function diasUteisRestantes(mes) {
  const [y, m] = mes.split('-').map(Number)
  const hoje = new Date(Date.now() - 3*3600*1000)
  const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate()
  // se o mês pedido não é o atual, considera o mês inteiro
  const mesAtualStr = hoje.toISOString().slice(0,7)
  let diaInicio = 1
  if (mes === mesAtualStr) diaInicio = hoje.getUTCDate()
  else if (mes < mesAtualStr) return 0 // mês passado: sem dias restantes
  let count = 0
  for (let d = diaInicio; d <= ultimoDia; d++) {
    const dow = new Date(Date.UTC(y, m-1, d)).getUTCDay()
    if (!FECHA_DIAS.includes(dow)) count++
  }
  return count
}

// ---- calcula o REALIZADO do mês (por unidade e por colaborador) ----
async function realizadoMes(mes, unidade_id) {
  const { ini, fim } = rangeMes(mes)

  // produtos de BAR = categorias que não pagam comissão
  let barProdIds = new Set()
  {
    const { data: barCats } = await supabaseAdmin.from('categorias_produto').select('id').eq('paga_comissao', false)
    const catIds = (barCats || []).map(c => c.id)
    if (catIds.length) {
      const { data: bp } = await supabaseAdmin.from('produtos').select('id').in('categoria_id', catIds)
      barProdIds = new Set((bp || []).map(p => p.id))
    }
  }

  // comandas finalizadas do mês
  let qc = supabaseAdmin.from('comandas')
    .select('id, total, colaborador_id, cliente_id, unidade_id, observacao')
    .eq('status', 'finalizada')
    .gte('finalizada_em', ini).lte('finalizada_em', fim)
  if (unidade_id) qc = qc.eq('unidade_id', unidade_id)
  const { data: comandas } = await qc
  const comandaIds = (comandas || []).map(c => c.id)

  // itens dessas comandas
  let itens = []
  if (comandaIds.length) {
    // busca em blocos (limite do in())
    for (let i = 0; i < comandaIds.length; i += 300) {
      const bloco = comandaIds.slice(i, i+300)
      const { data: it } = await supabaseAdmin.from('itens_comanda')
        .select('comanda_id, tipo, produto_id, quantidade, valor_unit')
        .in('comanda_id', bloco)
      if (it) itens = itens.concat(it)
    }
  }
  // mapa comanda -> colaborador
  const colDe = {}; (comandas||[]).forEach(c => colDe[c.id] = c.colaborador_id)

  // acumuladores: total geral e por colaborador
  function novo() { return { clientes:0, faturamento:0, produtos:0, planos:0, bar:0, _clientesSet:new Set() } }
  const geral = novo()
  const porColab = {}

  ;(comandas || []).forEach(c => {
    geral.faturamento += parseFloat(c.total) || 0
    if (c.cliente_id) geral._clientesSet.add(c.cliente_id)
    const cid = c.colaborador_id
    if (cid) {
      if (!porColab[cid]) porColab[cid] = novo()
      porColab[cid].faturamento += parseFloat(c.total) || 0
      if (c.cliente_id) porColab[cid]._clientesSet.add(c.cliente_id)
    }
  })

  ;(itens || []).forEach(it => {
    const q = parseInt(it.quantidade) || 1
    const tipo = String(it.tipo || '').toLowerCase()
    const cid = colDe[it.comanda_id]
    const bucket = cid && porColab[cid] ? porColab[cid] : null
    if (tipo.indexOf('produto') !== -1) {
      const v = (parseFloat(it.valor_unit)||0) * q
      const ehBar = it.produto_id && barProdIds.has(it.produto_id)
      if (ehBar) { geral.bar += v; if (bucket) bucket.bar += v }   // bar = R$
      else {
        // produtos barbearia = UNIDADES vendidas; não conta cortesia/resgate (valor unit < R$0,10)
        const unitVal = parseFloat(it.valor_unit) || 0
        if (unitVal >= 0.10) { geral.produtos += q; if (bucket) bucket.produtos += q }
      }
    } else if (tipo.indexOf('plano') !== -1) {
      // planos são contados à parte (só NOVOS), fora do loop de itens — ver abaixo
    }
  })

  // PLANOS NOVOS = assinaturas criadas no mês (data_inicio no período).
  // Renovação ATUALIZA a assinatura (não mexe em data_inicio) → não conta aqui.
  // Unidade/atribuição vêm do vendedor_id (a assinatura não grava unidade_id).
  {
    const dIni = String(ini).slice(0, 10), dFim = String(fim).slice(0, 10)
    const { data: novasAssin } = await supabaseAdmin.from('assinaturas')
      .select('vendedor_id, data_inicio, status')
      .gte('data_inicio', dIni).lte('data_inicio', dFim)
    const vendIds = [...new Set((novasAssin || []).map(a => a.vendedor_id).filter(Boolean))]
    const uniDe = {}
    if (vendIds.length) {
      const { data: vends } = await supabaseAdmin.from('colaboradores').select('id, unidade_id').in('id', vendIds)
      ;(vends || []).forEach(v => { uniDe[v.id] = v.unidade_id })
    }
    ;(novasAssin || []).forEach(a => {
      if (String(a.status) === 'cancelada') return               // venda desfeita não conta
      const uni = uniDe[a.vendedor_id]
      if (unidade_id && uni !== unidade_id) return                // filtra pela unidade do vendedor
      geral.planos += 1
      const vid = a.vendedor_id
      if (vid) { if (!porColab[vid]) porColab[vid] = novo(); porColab[vid].planos += 1 }
    })
  }

  // finaliza clientes (tamanho do set)
  function fechar(o) {
    return { clientes:o._clientesSet.size, faturamento:round(o.faturamento), produtos:o.produtos, planos:o.planos, bar:round(o.bar) }
  }
  const geralF = fechar(geral)
  const porColabF = {}
  Object.keys(porColab).forEach(k => porColabF[k] = fechar(porColab[k]))
  return { geral: geralF, porColab: porColabF }
}

// ------------------------------------------------------------
// GET /metas/unidade?mes=AAAA-MM[&unidade_id=..]  -> meta(s) cadastrada(s)
// ------------------------------------------------------------
router.get('/unidade', autenticar, GESTOR, TELA_METAS, async (req, res) => {
  try {
    const mes = req.query.mes || mesAtual()
    let q = supabaseAdmin.from('metas_unidade').select('*').eq('mes', mes)
    // gerente só vê a própria unidade
    if (req.usuario.perfil === 'gerente') q = q.eq('unidade_id', req.usuario.unidade_id)
    else if (req.query.unidade_id) q = q.eq('unidade_id', req.query.unidade_id)
    const { data } = await q
    return res.json(data || [])
  } catch (err) {
    console.error('[metas/unidade GET]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar metas' })
  }
})

// ------------------------------------------------------------
// POST /metas/unidade  { unidade_id, mes, clientes, faturamento, produtos, planos, bar }
// Só proprietário cadastra a meta da unidade.
// ------------------------------------------------------------
router.post('/unidade', autenticar, PROP, TELA_METAS, async (req, res) => {
  try {
    const { unidade_id, mes } = req.body
    if (!unidade_id || !mes) return res.status(400).json({ erro: 'Informe unidade_id e mes.' })
    const reg = {
      unidade_id, mes,
      clientes:    round(req.body.clientes),
      faturamento: round(req.body.faturamento),
      produtos:    round(req.body.produtos),
      planos:      round(req.body.planos),
      bar:         round(req.body.bar),
      criado_por:  req.usuario.id,
      atualizado_em: new Date().toISOString(),
    }
    const { data, error } = await supabaseAdmin.from('metas_unidade')
      .upsert(reg, { onConflict: 'unidade_id,mes' }).select().single()
    if (error) throw error
    return res.json({ ok: true, meta: data })
  } catch (err) {
    console.error('[metas/unidade POST]', err.message)
    return res.status(500).json({ erro: 'Erro ao salvar meta: ' + err.message })
  }
})

// ------------------------------------------------------------
// GET /metas/colaboradores?mes=AAAA-MM[&unidade_id=..]  -> divisão por barbeiro
// ------------------------------------------------------------
router.get('/colaboradores', autenticar, GESTOR, TELA_METAS, async (req, res) => {
  try {
    const mes = req.query.mes || mesAtual()
    let uni = req.query.unidade_id
    if (req.usuario.perfil === 'gerente') uni = req.usuario.unidade_id
    let q = supabaseAdmin.from('metas_colaborador').select('*').eq('mes', mes)
    if (uni) q = q.eq('unidade_id', uni)
    const { data } = await q
    return res.json(data || [])
  } catch (err) {
    console.error('[metas/colaboradores GET]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar metas por colaborador' })
  }
})

// ------------------------------------------------------------
// POST /metas/colaborador  { colaborador_id, unidade_id, mes, clientes, faturamento, produtos, planos, bar }
// Gerente distribui (livre). Proprietário também pode.
// ------------------------------------------------------------
router.post('/colaborador', autenticar, GESTOR, TELA_METAS, async (req, res) => {
  try {
    const { colaborador_id, mes } = req.body
    let unidade_id = req.body.unidade_id
    if (req.usuario.perfil === 'gerente') unidade_id = req.usuario.unidade_id
    if (!colaborador_id || !unidade_id || !mes) return res.status(400).json({ erro: 'Informe colaborador_id, unidade_id e mes.' })
    const reg = {
      colaborador_id, unidade_id, mes,
      clientes:    round(req.body.clientes),
      faturamento: round(req.body.faturamento),
      produtos:    round(req.body.produtos),
      planos:      round(req.body.planos),
      bar:         round(req.body.bar),
      criado_por:  req.usuario.id,
      atualizado_em: new Date().toISOString(),
    }
    const { data, error } = await supabaseAdmin.from('metas_colaborador')
      .upsert(reg, { onConflict: 'colaborador_id,mes' }).select().single()
    if (error) throw error
    return res.json({ ok: true, meta: data })
  } catch (err) {
    console.error('[metas/colaborador POST]', err.message)
    return res.status(500).json({ erro: 'Erro ao salvar meta do colaborador: ' + err.message })
  }
})

// ------------------------------------------------------------
// GET /metas/progresso?mes=AAAA-MM[&unidade_id=..][&colaborador_id=..]
// Retorna meta + realizado + % + bússola (falta por dia útil).
// ------------------------------------------------------------
router.get('/progresso', autenticar, async (req, res) => {
  try {
    const mes = req.query.mes || mesAtual()
    const u = req.usuario
    const CATS = ['clientes','faturamento','produtos','planos','bar']

    // escopo por perfil
    let unidade_id = req.query.unidade_id
    let colaborador_id = req.query.colaborador_id
    if (u.perfil === 'colaborador') { colaborador_id = u.id; unidade_id = u.unidade_id }
    else if (u.perfil === 'gerente') { unidade_id = u.unidade_id }   // gerente: meta própria + rank (ramo dedicado abaixo)

    const diasRest = diasUteisRestantes(mes)

    function montar(meta, realizado) {
      const out = { mes, dias_uteis_restantes: diasRest, categorias: {} }
      CATS.forEach(cat => {
        const alvo = parseFloat(meta && meta[cat]) || 0
        const feito = parseFloat(realizado && realizado[cat]) || 0
        const falta = Math.max(0, round(alvo - feito))
        out.categorias[cat] = {
          meta: alvo,
          realizado: round(feito),
          pct: alvo > 0 ? Math.round(feito / alvo * 100) : 0,
          falta,
          por_dia: (alvo > 0 && diasRest > 0) ? round(falta / diasRest) : 0,
        }
      })
      return out
    }

    // PROPRIETÁRIO: visão por UNIDADE (todas as unidades ativas) — cada uma com meta + realizado
    if (u.perfil === 'proprietario' && !colaborador_id && !unidade_id) {
      const { data: unidades } = await supabaseAdmin.from('unidades')
        .select('id, nome').eq('ativa', true).order('nome')
      const lista = []
      for (const un of (unidades || [])) {
        const realU = await realizadoMes(mes, un.id)
        const { data: metaU } = await supabaseAdmin.from('metas_unidade')
          .select('*').eq('unidade_id', un.id).eq('mes', mes).maybeSingle()
        lista.push({ unidade_id: un.id, nome: un.nome, ...montar(metaU, realU.geral) })
      }
      return res.json({ tipo:'proprietario', unidades: lista })
    }

    const real = await realizadoMes(mes, unidade_id)

    // COLABORADOR: só a própria meta
    if (colaborador_id) {
      const { data: metaCol } = await supabaseAdmin.from('metas_colaborador')
        .select('*').eq('colaborador_id', colaborador_id).eq('mes', mes).maybeSingle()
      const realizado = real.porColab[colaborador_id] || { clientes:0, faturamento:0, produtos:0, planos:0, bar:0 }
      return res.json({ tipo:'colaborador', colaborador_id, ...montar(metaCol, realizado) })
    }

    // GERENTE: meta PRÓPRIA + meta da UNIDADE (geral) + rank por barbeiro (p/ aba na página de metas)
    if (u.perfil === 'gerente') {
      const { data: metaGer } = await supabaseAdmin.from('metas_colaborador')
        .select('*').eq('colaborador_id', u.id).eq('mes', mes).maybeSingle()
      const minha = montar(metaGer, real.porColab[u.id] || {})
      const { data: metaUniG } = await supabaseAdmin.from('metas_unidade')
        .select('*').eq('unidade_id', unidade_id).eq('mes', mes).maybeSingle()
      const unidadeG = montar(metaUniG, real.geral)
      const { data: metasColG } = await supabaseAdmin.from('metas_colaborador')
        .select('*').eq('unidade_id', unidade_id).eq('mes', mes)
      const cidsG = [...new Set((metasColG || []).map(m => m.colaborador_id).filter(Boolean))]
      const nomeColG = {}
      if (cidsG.length) {
        const { data: colsG } = await supabaseAdmin.from('colaboradores').select('id, nome').in('id', cidsG)
        ;(colsG || []).forEach(c => { nomeColG[c.id] = c.nome })
      }
      const barbeirosG = (metasColG || []).map(mc => ({
        colaborador_id: mc.colaborador_id,
        nome: nomeColG[mc.colaborador_id] || '—',
        ...montar(mc, real.porColab[mc.colaborador_id] || {})
      }))
      return res.json({ tipo:'gerente', colaborador_id: u.id, mes, dias_uteis_restantes: diasRest, categorias: minha.categorias, unidade: unidadeG.categorias, barbeiros: barbeirosG })
    }

    // UNIDADE (gerente/proprietário): meta da unidade + progresso + lista por barbeiro
    const { data: metaUni } = await supabaseAdmin.from('metas_unidade')
      .select('*').eq('unidade_id', unidade_id).eq('mes', mes).maybeSingle()
    const unidadeProg = montar(metaUni, real.geral)

    // por barbeiro (nomes buscados à parte — sem embed, que falha no PostgREST)
    const { data: metasCol } = await supabaseAdmin.from('metas_colaborador')
      .select('*').eq('unidade_id', unidade_id).eq('mes', mes)
    const cidsU = [...new Set((metasCol || []).map(m => m.colaborador_id).filter(Boolean))]
    const nomeColU = {}
    if (cidsU.length) {
      const { data: colsU } = await supabaseAdmin.from('colaboradores').select('id, nome').in('id', cidsU)
      ;(colsU || []).forEach(c => { nomeColU[c.id] = c.nome })
    }
    const barbeiros = (metasCol || []).map(mc => ({
      colaborador_id: mc.colaborador_id,
      nome: nomeColU[mc.colaborador_id] || '—',
      ...montar(mc, real.porColab[mc.colaborador_id] || {})
    }))

    return res.json({ tipo:'unidade', unidade_id, unidade: unidadeProg, barbeiros })
  } catch (err) {
    console.error('[metas/progresso]', err.message)
    return res.status(500).json({ erro: 'Erro ao calcular progresso: ' + err.message })
  }
})

module.exports = router
