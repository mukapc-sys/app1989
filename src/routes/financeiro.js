const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

const SEM_ACESSO = exigirPerfil('proprietario', 'gerente')

// GET /financeiro/resumo?unidade_id=xxx&periodo=mes
router.get('/resumo', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { unidade_id, periodo = 'mes' } = req.query
    const u = req.usuario

    const { ini, fim } = getPeriodo(periodo)
    const uid = u.perfil === 'proprietario' ? unidade_id : u.unidade_id

    let query = supabaseAdmin
      .from('comandas')
      .select('total, forma_pgto, colaborador_id')
      .eq('status', 'finalizada')
      .gte('finalizada_em', ini).lte('finalizada_em', fim)

    if (uid) query = query.eq('unidade_id', uid)

    const { data: comandas, error } = await query
    if (error) throw error

    const faturamento   = somar(comandas, 'total')
    const total_credito = somar(comandas.filter(c => c.forma_pgto === 'credito'), 'total')
    const total_debito  = somar(comandas.filter(c => c.forma_pgto === 'debito'),  'total')
    const total_pix     = somar(comandas.filter(c => c.forma_pgto === 'pix'),     'total')
    const total_dinheiro= somar(comandas.filter(c => c.forma_pgto === 'dinheiro'),'total')

    // Busca comissões
    const { data: colabs } = await supabaseAdmin
      .from('colaboradores').select('id, comissao_pct')
    const comissoes = (comandas || []).reduce((acc, c) => {
      const col = (colabs || []).find(x => x.id === c.colaborador_id)
      return acc + (col ? parseFloat(c.total) * col.comissao_pct / 100 : 0)
    }, 0)

    // AppBarber finalizado FORA do sistema (observação no caixa)
    const ab = await appbarberRealizados(ini, fim, uid)
    const abFaturamento = somar(ab, 'valor')
    const abComissao = ab.reduce((acc, a) => {
      const col = (colabs || []).find(x => x.id === a.colaborador_id)
      return acc + (col ? parseFloat(a.valor || 0) * col.comissao_pct / 100 : 0)
    }, 0)

    const faturamentoTotal = faturamento + abFaturamento
    const comissoesTotal   = comissoes + abComissao
    const atendimentos     = comandas.length + ab.length

    return res.json({
      periodo,
      faturamento:    round(faturamentoTotal),
      comissoes:      round(comissoesTotal),
      liquido:        round(faturamentoTotal - comissoesTotal),
      total_comandas: atendimentos,
      ticket_medio:   atendimentos ? round(faturamentoTotal / atendimentos) : 0,
      faturamento_appbarber: round(abFaturamento),  // observação: pago no AppBarber
      comissao_appbarber:    round(abComissao),
      formas: {
        credito:  round(total_credito),
        debito:   round(total_debito),
        pix:      round(total_pix),
        dinheiro: round(total_dinheiro),
        appbarber: round(abFaturamento)             // pago fora do caixa do sistema
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao buscar resumo financeiro' })
  }
})

// GET /financeiro/comissoes?periodo=mes
router.get('/comissoes', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { periodo = 'mes', unidade_id } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)
    const uid = u.perfil === 'proprietario' ? unidade_id : u.unidade_id

    const { data, error } = await supabaseAdmin
      .from('vw_comissoes_mes')
      .select('*')
      .gte('mes', ini).lte('mes', fim)

    if (uid) {
      const filtered = (data || []).filter(r => r.unidade_nome !== undefined)
      return res.json(filtered)
    }
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar comissões' })
  }
})

// GET /financeiro/comissao-propria?periodo=mes — barbeiro vê a própria
router.get('/comissao-propria', autenticar, exigirPerfil('colaborador', 'gerente'), async (req, res) => {
  try {
    const { periodo = 'mes' } = req.query
    const { ini, fim } = getPeriodo(periodo)

    const { data: col } = await supabaseAdmin
      .from('colaboradores').select('comissao_pct').eq('id', req.usuario.id).single()
    if (!col) return res.status(404).json({ erro: 'Colaborador não encontrado' })

    const { data: comandas } = await supabaseAdmin
      .from('comandas').select('total')
      .eq('colaborador_id', req.usuario.id)
      .eq('status', 'finalizada')
      .gte('finalizada_em', ini).lte('finalizada_em', fim)

    const faturado  = somar(comandas || [], 'total')
    const comissao  = round(faturado * col.comissao_pct / 100)

    return res.json({
      periodo,
      total_comandas: (comandas || []).length,
      faturado:       round(faturado),
      comissao_pct:   col.comissao_pct,
      comissao
    })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar comissão' })
  }
})

// GET /relatorios/servicos?periodo=mes
router.get('/relatorios/servicos', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { periodo = 'mes', unidade_id } = req.query
    const { ini, fim } = getPeriodo(periodo)

    const { data, error } = await supabaseAdmin
      .from('itens_comanda')
      .select('descricao, quantidade, valor_total, servico_id, comandas(unidade_id, finalizada_em, status)')
      .eq('tipo', 'servico')
      .not('servico_id', 'is', null)

    if (error) throw error

    const filtrado = (data || []).filter(i =>
      i.comandas?.status === 'finalizada' &&
      i.comandas?.finalizada_em >= ini &&
      i.comandas?.finalizada_em <= fim &&
      (!unidade_id || i.comandas?.unidade_id === unidade_id)
    )

    // Agrupa por serviço
    const mapa = {}
    filtrado.forEach(i => {
      if (!mapa[i.descricao]) mapa[i.descricao] = { nome: i.descricao, quantidade: 0, faturado: 0 }
      mapa[i.descricao].quantidade += i.quantidade
      mapa[i.descricao].faturado   += parseFloat(i.valor_total)
    })

    const ranking = Object.values(mapa)
      .map(r => ({ ...r, faturado: round(r.faturado) }))
      .sort((a, b) => b.faturado - a.faturado)

    return res.json(ranking)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar relatório de serviços' })
  }
})

// GET /relatorios/retencao
router.get('/relatorios/retencao', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('vw_clientes_reativar').select('*')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar retenção' })
  }
})

// GET /relatorios/estoque-alertas
router.get('/relatorios/estoque', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('vw_estoque_alertas').select('*')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar estoque' })
  }
})

// GET /financeiro/comissoes-barbeiro?periodo=mes&unidade_id=xxx — comissão real por barbeiro
router.get('/comissoes-barbeiro', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { periodo = 'mes', unidade_id } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)
    const uid = u.perfil === 'proprietario' ? unidade_id : u.unidade_id

    let query = supabaseAdmin
      .from('comandas').select('total, colaborador_id')
      .eq('status', 'finalizada').gte('finalizada_em', ini).lte('finalizada_em', fim)
    if (uid) query = query.eq('unidade_id', uid)
    const { data: comandas, error } = await query
    if (error) throw error

    const { data: colabs } = await supabaseAdmin
      .from('colaboradores').select('id, nome, comissao_pct, unidade_id')
    const { data: unidades } = await supabaseAdmin.from('unidades').select('id, nome')

    const mapa = {}
    ;(comandas || []).forEach(c => {
      const col = (colabs || []).find(x => x.id === c.colaborador_id)
      if (!col) return
      if (!mapa[col.id]) {
        const un = (unidades || []).find(x => x.id === col.unidade_id)
        mapa[col.id] = {
          nome: col.nome,
          unidade: (un ? un.nome : '').replace('Unidade ', ''),
          comissao_pct: col.comissao_pct || 0,
          atendimentos: 0, faturado: 0
        }
      }
      mapa[col.id].atendimentos += 1
      mapa[col.id].faturado += parseFloat(c.total || 0)
    })

    // AppBarber finalizado fora do sistema (entra na comissão, marcado como observação)
    const ab = await appbarberRealizados(ini, fim, uid)
    ;(ab || []).forEach(a => {
      const col = (colabs || []).find(x => x.id === a.colaborador_id)
      if (!col) return
      if (!mapa[col.id]) {
        const un = (unidades || []).find(x => x.id === col.unidade_id)
        mapa[col.id] = {
          nome: col.nome,
          unidade: (un ? un.nome : '').replace('Unidade ', ''),
          comissao_pct: col.comissao_pct || 0,
          atendimentos: 0, faturado: 0, ab_faturado: 0
        }
      }
      mapa[col.id].atendimentos += 1
      mapa[col.id].faturado += parseFloat(a.valor || 0)
      mapa[col.id].ab_faturado = (mapa[col.id].ab_faturado || 0) + parseFloat(a.valor || 0)
    })

    const lista = Object.values(mapa)
      .map(r => ({ ...r, faturado: round(r.faturado), ab_faturado: round(r.ab_faturado || 0), comissao: round(r.faturado * r.comissao_pct / 100) }))
      .sort((a, b) => b.faturado - a.faturado)
    return res.json(lista)
  } catch (err) {
    console.error('[comissoes-barbeiro]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar comissões por barbeiro' })
  }
})

// GET /financeiro/por-unidade?periodo=mes — faturamento e atendimentos reais por unidade
router.get('/por-unidade', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { periodo = 'mes' } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)

    let query = supabaseAdmin
      .from('comandas').select('total, unidade_id, colaborador_id')
      .eq('status', 'finalizada').gte('finalizada_em', ini).lte('finalizada_em', fim)
    if (u.perfil !== 'proprietario' && u.unidade_id) query = query.eq('unidade_id', u.unidade_id)
    const { data: comandas, error } = await query
    if (error) throw error

    const { data: unidades } = await supabaseAdmin.from('unidades').select('id, nome')
    const mapa = {}
    ;(comandas || []).forEach(c => {
      if (!c.unidade_id) return
      if (!mapa[c.unidade_id]) mapa[c.unidade_id] = { atendimentos: 0, faturado: 0, ab_faturado: 0, barbeiros: new Set() }
      mapa[c.unidade_id].atendimentos += 1
      mapa[c.unidade_id].faturado += parseFloat(c.total || 0)
      if (c.colaborador_id) mapa[c.unidade_id].barbeiros.add(c.colaborador_id)
    })

    // AppBarber finalizado fora do sistema
    const abUid = u.perfil === 'proprietario' ? null : u.unidade_id
    const ab = await appbarberRealizados(ini, fim, abUid)
    ;(ab || []).forEach(a => {
      if (!a.unidade_id) return
      if (!mapa[a.unidade_id]) mapa[a.unidade_id] = { atendimentos: 0, faturado: 0, ab_faturado: 0, barbeiros: new Set() }
      mapa[a.unidade_id].atendimentos += 1
      mapa[a.unidade_id].faturado += parseFloat(a.valor || 0)
      mapa[a.unidade_id].ab_faturado += parseFloat(a.valor || 0)
      if (a.colaborador_id) mapa[a.unidade_id].barbeiros.add(a.colaborador_id)
    })

    const lista = Object.keys(mapa).map(uid => {
      const un = (unidades || []).find(x => x.id === uid)
      return {
        nome: (un ? un.nome : 'Unidade').replace('Unidade ', ''),
        atendimentos: mapa[uid].atendimentos,
        faturado: round(mapa[uid].faturado),
        ab_faturado: round(mapa[uid].ab_faturado || 0),
        barbeiros: mapa[uid].barbeiros.size
      }
    }).sort((a, b) => b.faturado - a.faturado)
    return res.json(lista)
  } catch (err) {
    console.error('[por-unidade]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar faturamento por unidade' })
  }
})

// GET /financeiro/produtos?periodo=mes&unidade_id=xxx — venda de produtos real
router.get('/produtos', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { periodo = 'mes', unidade_id } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)
    const uid = u.perfil === 'proprietario' ? unidade_id : u.unidade_id

    const { data, error } = await supabaseAdmin
      .from('itens_comanda')
      .select('descricao, quantidade, valor_total, comandas(unidade_id, finalizada_em, status)')
      .eq('tipo', 'produto')
    if (error) throw error

    const filt = (data || []).filter(i =>
      i.comandas?.status === 'finalizada' &&
      i.comandas?.finalizada_em >= ini &&
      i.comandas?.finalizada_em <= fim &&
      (!uid || i.comandas?.unidade_id === uid)
    )
    const mapa = {}; let total = 0
    filt.forEach(i => {
      if (!mapa[i.descricao]) mapa[i.descricao] = { nome: i.descricao, quantidade: 0, faturado: 0 }
      mapa[i.descricao].quantidade += i.quantidade
      mapa[i.descricao].faturado += parseFloat(i.valor_total || 0)
      total += parseFloat(i.valor_total || 0)
    })
    const ranking = Object.values(mapa).map(r => ({ ...r, faturado: round(r.faturado) })).sort((a, b) => b.faturado - a.faturado)
    return res.json({ total: round(total), ranking })
  } catch (err) {
    console.error('[produtos]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar venda de produtos' })
  }
})

// Helpers
function getPeriodo(periodo) {
  const agora = new Date()
  let ini, fim

  if (periodo === 'hoje') {
    ini = new Date(agora.setHours(0,0,0,0)).toISOString()
    fim = new Date(agora.setHours(23,59,59,999)).toISOString()
  } else if (periodo === 'semana') {
    const dom = new Date(agora)
    dom.setDate(agora.getDate() - agora.getDay())
    dom.setHours(0,0,0,0)
    ini = dom.toISOString()
    fim = new Date().toISOString()
  } else if (periodo === 'mes') {
    ini = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString()
    fim = new Date().toISOString()
  } else if (periodo === 'trim') {
    const m = Math.floor(agora.getMonth() / 3) * 3
    ini = new Date(agora.getFullYear(), m, 1).toISOString()
    fim = new Date().toISOString()
  } else if (periodo === 'ano') {
    ini = new Date(agora.getFullYear(), 0, 1).toISOString()
    fim = new Date().toISOString()
  } else {
    ini = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString()
    fim = new Date().toISOString()
  }
  return { ini, fim }
}

function somar(arr, campo) {
  return (arr || []).reduce((s, r) => s + parseFloat(r[campo] || 0), 0)
}

function round(n) {
  return Math.round(n * 100) / 100
}

// Agendamentos do AppBarber FINALIZADOS FORA do sistema (pagos no AppBarber):
//  tipo=agendamento, status=realizado, e SEM comanda no sistema (agendamento_id IS NULL).
//  Entram no faturamento/comissão como "observação" (não passaram pelo caixa físico).
async function appbarberRealizados(ini, fim, uid) {
  let q = supabaseAdmin.from('agenda_appbarber')
    .select('valor, colaborador_id, unidade_id, inicio')
    .eq('tipo', 'agendamento')
    .is('agendamento_id', null)
    .eq('status', 'realizado')
    .gte('inicio', ini).lte('inicio', fim)
  if (uid) q = q.eq('unidade_id', uid)
  const { data } = await q
  return data || []
}

// GET /financeiro/comparativo?mes1=2026-03&mes2=2026-04[&unidade_id=xxx]
// Comparativo mês x mês por BARBEIRO e por UNIDADE.
// Métricas: atendimentos, produtos (qtd), serviços (R$), produtos/bar (R$), geral (R$), ticket médio.
// Fonte: comandas finalizadas + AppBarber realizado (igual ao restante do Financeiro).
router.get('/comparativo', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const u = req.usuario
    const hoje = new Date()
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
    const mesAtual = ym(hoje)
    const mesAnterior = ym(new Date(hoje.getFullYear(), hoje.getMonth()-1, 1))
    const mes1 = req.query.mes1 || mesAnterior
    const mes2 = req.query.mes2 || mesAtual
    const uidFiltro = u.perfil === 'gerente' ? u.unidade_id : (req.query.unidade_id || null)

    const rangeMes = (mes) => {
      const [y,m] = mes.split('-').map(Number)
      const prox = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`
      return { ini: `${mes}-01T00:00:00-03:00`, fim: `${prox}-01T00:00:00-03:00` }
    }

    let qCol = supabaseAdmin.from('colaboradores').select('id, nome, unidade_id')
    if (uidFiltro) qCol = qCol.eq('unidade_id', uidFiltro)
    const { data: colabs } = await qCol
    let qUni = supabaseAdmin.from('unidades').select('id, nome')
    if (uidFiltro) qUni = qUni.eq('id', uidFiltro)
    const { data: unids } = await qUni

    const vazio = () => ({ atend:0, prod_qtd:0, valor_serv:0, valor_prod:0 })

    async function metricasMes(mes) {
      const { ini, fim } = rangeMes(mes)
      const porColab = {}, porUni = {}
      const eC = (id) => (porColab[id] = porColab[id] || vazio())
      const eU = (id) => (porUni[id]   = porUni[id]   || vazio())

      // Comandas finalizadas → atendimentos
      let qc = supabaseAdmin.from('comandas')
        .select('colaborador_id, unidade_id')
        .eq('status','finalizada').gte('finalizada_em', ini).lt('finalizada_em', fim)
      if (uidFiltro) qc = qc.eq('unidade_id', uidFiltro)
      const { data: cmds } = await qc
      for (const c of (cmds||[])) {
        if (c.colaborador_id) eC(c.colaborador_id).atend++
        if (c.unidade_id)     eU(c.unidade_id).atend++
      }

      // Itens (serviço x produto)
      const { data: itens } = await supabaseAdmin.from('itens_comanda')
        .select('tipo, valor_total, quantidade, comandas(colaborador_id, unidade_id, finalizada_em, status)')
      for (const i of (itens||[])) {
        const c = i.comandas
        if (!c || c.status !== 'finalizada') continue
        if (!(c.finalizada_em >= ini && c.finalizada_em < fim)) continue
        if (uidFiltro && c.unidade_id !== uidFiltro) continue
        const v = parseFloat(i.valor_total) || 0
        const q = parseInt(i.quantidade) || 0
        if (i.tipo === 'produto') {
          if (c.colaborador_id){ const x=eC(c.colaborador_id); x.valor_prod+=v; x.prod_qtd+=q }
          if (c.unidade_id)    { const y=eU(c.unidade_id);     y.valor_prod+=v; y.prod_qtd+=q }
        } else {
          if (c.colaborador_id) eC(c.colaborador_id).valor_serv += v
          if (c.unidade_id)     eU(c.unidade_id).valor_serv += v
        }
      }

      // AppBarber realizado (pago fora) → serviço + atendimento
      const ab = await appbarberRealizados(ini, fim, uidFiltro)
      for (const a of ab) {
        const v = parseFloat(a.valor) || 0
        if (a.colaborador_id){ const x=eC(a.colaborador_id); x.valor_serv+=v; x.atend++ }
        if (a.unidade_id)    { const y=eU(a.unidade_id);     y.valor_serv+=v; y.atend++ }
      }

      return { porColab, porUni }
    }

    const M1 = await metricasMes(mes1)
    const M2 = await metricasMes(mes2)

    const finaliza = (m) => ({
      atend: m.atend, prod_qtd: m.prod_qtd,
      valor_serv: m.valor_serv, valor_prod: m.valor_prod,
      geral: m.valor_serv + m.valor_prod,
      ticket: m.atend > 0 ? m.valor_serv / m.atend : 0
    })

    const nomeUni = {}; (unids||[]).forEach(x => nomeUni[x.id] = x.nome)

    // BARBEIROS (só os que tiveram movimento em algum dos meses)
    const idsColab = new Set([...Object.keys(M1.porColab), ...Object.keys(M2.porColab)])
    const barbeiros = (colabs||[])
      .filter(col => idsColab.has(col.id))
      .map(col => ({
        id: col.id, nome: col.nome,
        unidade_id: col.unidade_id, unidade_nome: nomeUni[col.unidade_id] || '—',
        m1: finaliza(M1.porColab[col.id] || vazio()),
        m2: finaliza(M2.porColab[col.id] || vazio())
      }))
      .sort((a,b) => (a.unidade_nome||'').localeCompare(b.unidade_nome||'') || b.m2.geral - a.m2.geral)

    // UNIDADES
    const idsUni = new Set([...Object.keys(M1.porUni), ...Object.keys(M2.porUni), ...(unids||[]).map(x=>x.id)])
    const unidades = [...idsUni]
      .filter(uid => !uidFiltro || uid === uidFiltro)
      .map(uid => ({
        id: uid, nome: nomeUni[uid] || '—',
        m1: finaliza(M1.porUni[uid] || vazio()),
        m2: finaliza(M2.porUni[uid] || vazio())
      }))
      .sort((a,b) => b.m2.geral - a.m2.geral)

    const somar = (lista, chave) => {
      const t = { atend:0, prod_qtd:0, valor_serv:0, valor_prod:0, geral:0 }
      lista.forEach(r => { t.atend+=r[chave].atend; t.prod_qtd+=r[chave].prod_qtd; t.valor_serv+=r[chave].valor_serv; t.valor_prod+=r[chave].valor_prod; t.geral+=r[chave].geral })
      t.ticket = t.atend > 0 ? t.valor_serv / t.atend : 0
      return t
    }

    return res.json({
      mes1, mes2, barbeiros, unidades,
      totais: { m1: somar(unidades,'m1'), m2: somar(unidades,'m2') }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao gerar comparativo' })
  }
})

// ===================== DRE / BALANCETE =====================
// Categorias de despesa padrão (COMISSÃO é calculada à parte, automática)
const DRE_CATEGORIAS = ['ATENDENTE','GERENTE','ADMINISTRADOR','LIMPEZA','EXTRA','ALUGUEL','MERCADO','GIRO','LF','INSUMOS','MARKETING','CONTADOR','IMPOSTOS','PRODUTOS','LUZ','AGUA','INTERNET/SPOTIFY','SEGURANÇA','DIV/BAR']
const DRE_FORMAS = [['Dinheiro','dinheiro'],['Débito','debito'],['Crédito','credito'],['Pix','pix'],['AppBarber','appbarber'],['Outros','outros']]

function rangeMesDre(mes) {
  const [y,m] = mes.split('-').map(Number)
  const prox = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`
  return { ini: `${mes}-01T00:00:00-03:00`, fim: `${prox}-01T00:00:00-03:00` }
}

// Entrada (por forma) e comissão calculadas automaticamente do sistema
async function autoDre(ini, fim, uid) {
  let qc = supabaseAdmin.from('comandas').select('total, forma_pgto, colaborador_id')
    .eq('status','finalizada').gte('finalizada_em', ini).lt('finalizada_em', fim)
  if (uid) qc = qc.eq('unidade_id', uid)
  const { data: cmds } = await qc

  const { data: cols } = await supabaseAdmin.from('colaboradores').select('id, comissao_pct')
  const pctMap = {}; (cols||[]).forEach(c => pctMap[c.id] = (c.comissao_pct != null ? c.comissao_pct : 40) / 100)

  const entrada = { dinheiro:0, debito:0, credito:0, pix:0, appbarber:0, outros:0 }
  let comissao = 0
  for (const c of (cmds||[])) {
    const f = ['dinheiro','debito','credito','pix'].includes(c.forma_pgto) ? c.forma_pgto : 'outros'
    const v = parseFloat(c.total)||0
    entrada[f] += v
    comissao += v * (pctMap[c.colaborador_id] || 0.4)
  }
  const ab = await appbarberRealizados(ini, fim, uid)
  for (const a of ab) {
    const v = parseFloat(a.valor)||0
    entrada.appbarber += v
    comissao += v * (pctMap[a.colaborador_id] || 0.4)
  }
  return { entrada, comissao }
}

// Monta o DRE de UMA unidade (mistura automático com o que foi salvo)
async function montarDre(uid, mes) {
  const { ini, fim } = rangeMesDre(mes)
  const { entrada: autoEnt, comissao: comAuto } = await autoDre(ini, fim, uid)

  const { data: linhas } = await supabaseAdmin.from('dre_lancamentos')
    .select('tipo, categoria, valor').eq('unidade_id', uid).eq('mes', mes)
  const savedEnt = {}, savedDesp = {}
  ;(linhas||[]).forEach(l => { (l.tipo==='entrada'?savedEnt:savedDesp)[l.categoria] = parseFloat(l.valor)||0 })
  const salvo = (linhas||[]).length > 0

  const entrada = DRE_FORMAS.map(([label,key]) => ({
    categoria: label,
    auto: round(autoEnt[key]||0),
    valor: savedEnt[label] != null ? savedEnt[label] : round(autoEnt[key]||0)
  }))

  const despesas = []
  despesas.push({ categoria:'COMISSÃO', comissao:true, auto: round(comAuto),
    valor: savedDesp['COMISSÃO'] != null ? savedDesp['COMISSÃO'] : round(comAuto) })
  DRE_CATEGORIAS.forEach(cat => despesas.push({ categoria:cat, valor: savedDesp[cat] != null ? savedDesp[cat] : 0 }))
  Object.keys(savedDesp).forEach(cat => {
    if (cat !== 'COMISSÃO' && !DRE_CATEGORIAS.includes(cat)) despesas.push({ categoria:cat, valor: savedDesp[cat], custom:true })
  })

  return { entrada, despesas, salvo }
}

function finalizaDre(mes, unidade_id, dre, consolidado) {
  const total_entrada = dre.entrada.reduce((s,e)=>s+(parseFloat(e.valor)||0),0)
  const total_despesa = dre.despesas.reduce((s,d)=>s+(parseFloat(d.valor)||0),0)
  return {
    mes, unidade_id, consolidado, salvo: dre.salvo,
    entrada: dre.entrada.map(e => ({ ...e, valor: round(e.valor) })),
    despesas: dre.despesas.map(d => ({ ...d, valor: round(d.valor) })),
    total_entrada: round(total_entrada),
    total_despesa: round(total_despesa),
    saldo: round(total_entrada - total_despesa)
  }
}

// GET /financeiro/dre?mes=2026-06[&unidade_id=xxx]  (sem unidade = consolidado de todas)
router.get('/dre', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const u = req.usuario
    const mes = req.query.mes || new Date().toISOString().slice(0,7)
    const uid = u.perfil === 'gerente' ? u.unidade_id : (req.query.unidade_id || '')

    if (uid) {
      const dre = await montarDre(uid, mes)
      return res.json(finalizaDre(mes, uid, dre, false))
    }

    // Consolidado: soma de todas as unidades
    const { data: unidades } = await supabaseAdmin.from('unidades').select('id')
    const aggEnt = {}, aggDesp = {}; let algumSalvo = false
    for (const un of (unidades||[])) {
      const p = await montarDre(un.id, mes)
      if (p.salvo) algumSalvo = true
      p.entrada.forEach(e => {
        aggEnt[e.categoria] = aggEnt[e.categoria] || { categoria:e.categoria, auto:0, valor:0 }
        aggEnt[e.categoria].auto += e.auto || 0; aggEnt[e.categoria].valor += e.valor || 0
      })
      p.despesas.forEach(d => {
        aggDesp[d.categoria] = aggDesp[d.categoria] || { categoria:d.categoria, auto:0, valor:0, comissao:d.comissao, custom:d.custom }
        aggDesp[d.categoria].auto += d.auto || 0; aggDesp[d.categoria].valor += d.valor || 0
      })
    }
    const dre = { entrada: Object.values(aggEnt), despesas: Object.values(aggDesp), salvo: algumSalvo }
    return res.json(finalizaDre(mes, '', dre, true))
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao montar DRE' })
  }
})

// POST /financeiro/dre/salvar  { unidade_id, mes, entrada:[{categoria,valor}], despesas:[{categoria,valor}] }
router.post('/dre/salvar', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const u = req.usuario
    const { mes, entrada = [], despesas = [] } = req.body
    const unidade_id = u.perfil === 'gerente' ? u.unidade_id : req.body.unidade_id
    if (!unidade_id || !mes) return res.status(400).json({ erro: 'unidade_id e mes são obrigatórios' })

    await supabaseAdmin.from('dre_lancamentos').delete().eq('unidade_id', unidade_id).eq('mes', mes)

    const linhas = []
    entrada.forEach((e,i) => { if (e && e.categoria) linhas.push({ unidade_id, mes, tipo:'entrada', categoria:String(e.categoria).slice(0,60), valor: parseFloat(e.valor)||0, ordem:i }) })
    despesas.forEach((d,i) => { if (d && d.categoria) linhas.push({ unidade_id, mes, tipo:'despesa', categoria:String(d.categoria).slice(0,60), valor: parseFloat(d.valor)||0, ordem:i }) })
    if (linhas.length) { const { error } = await supabaseAdmin.from('dre_lancamentos').insert(linhas); if (error) throw error }

    return res.json({ ok: true, salvos: linhas.length })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao salvar DRE' })
  }
})

module.exports = router
