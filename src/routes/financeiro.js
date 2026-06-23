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

module.exports = router
