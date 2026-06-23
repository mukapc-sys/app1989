const express = require('express')
const router  = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

// ============================================================
// GET /dashboard/metricas
// Retorna todos os dados do dashboard de acordo com o perfil
// ============================================================
router.get('/dashboard/metricas', autenticar, async (req, res) => {
  try {
    const usuario = req.usuario
    const agora = new Date()
    const anoHoje = agora.toLocaleString('en-CA', { timeZone: 'America/Sao_Paulo' }).split(',')[0]
    const inicioHoje = anoHoje + 'T00:00:00-03:00'
    const fimHoje    = anoHoje + 'T23:59:59-03:00'
    const inicioMes  = anoHoje.slice(0,7) + '-01T00:00:00-03:00' 

    // Busca colaborador logado — tenta por user_id (Supabase Auth) ou id direto
    console.log('[dashboard] usuario:', JSON.stringify(usuario))
    let colab = null
    
    // Tenta pelo user_id do Supabase Auth
    const { data: c1 } = await supabaseAdmin
      .from('colaboradores')
      .select('id, nome, perfil, unidade_id, unidades(id, nome)')
      .eq('user_id', usuario.id)
      .single()
    
    if (c1) {
      colab = c1
    } else {
      // Tenta pelo id direto da tabela colaboradores
      const { data: c2 } = await supabaseAdmin
        .from('colaboradores')
        .select('id, nome, perfil, unidade_id, unidades(id, nome)')
        .eq('id', usuario.id)
        .single()
      colab = c2
    }

    if (!colab) return res.status(404).json({ erro: 'Colaborador não encontrado' })

    const perfil     = colab.perfil
    const unidade_id = colab.unidade_id
    const result     = { perfil, colaborador: colab }

    // ---- Métricas de agendamentos ----
    const buildMetricas = async (uid) => {
      // Agendamentos hoje
      let qAgend = supabaseAdmin.from('agendamentos')
        .select('id, status, valor, colaborador_id, data_hora_ini')
        .gte('data_hora_ini', inicioHoje)
        .lte('data_hora_ini', fimHoje)
        .not('status', 'in', '("cancelado","bloqueado")')
      if (uid) qAgend = qAgend.eq('unidade_id', uid)
      const { data: agends } = await qAgend

      const total = agends?.filter(a => ['agendado','confirmado','concluido','nao_compareceu'].includes(a.status)).length || 0
      const finalizados = agends?.filter(a => a.status === 'concluido').length || 0
      const pendentes   = agends?.filter(a => ['agendado','confirmado'].includes(a.status)).length || 0
      const faturamento = agends?.filter(a => a.status === 'concluido').reduce((s,a) => s + (parseFloat(a.valor)||0), 0) || 0

      // ---- Importados do AppBarber que AINDA NÃO viraram agendamento de verdade ----
      // (agendamento_id IS NULL evita contar 2x quando já foi finalizado no sistema)
      let qAB = supabaseAdmin.from('agenda_appbarber')
        .select('status, valor, inicio')
        .eq('tipo', 'agendamento')
        .is('agendamento_id', null)
        .gte('inicio', inicioHoje).lte('inicio', fimHoje)
      if (uid) qAB = qAB.eq('unidade_id', uid)
      const { data: abrows } = await qAB
      const abValidos     = (abrows || []).filter(a => ['agendado','realizado'].includes(a.status))
      const abFinalizados = abValidos.filter(a => a.status === 'realizado').length
      const abPendentes   = abValidos.filter(a => a.status === 'agendado').length
      const abFaturamento = abValidos.filter(a => a.status === 'realizado').reduce((s,a) => s + (parseFloat(a.valor)||0), 0)

      const totalAll       = total + abValidos.length
      const finalizadosAll = finalizados + abFinalizados
      const pendentesAll   = pendentes + abPendentes
      const faturamentoAll = faturamento + abFaturamento
      const ticket         = finalizadosAll > 0 ? faturamentoAll / finalizadosAll : 0

      // Clientes a reativar (sem visita há +15 dias)
      let qReativar = supabaseAdmin.from('clientes').select('id', { count: 'exact', head: true })
        .lt('ultima_visita', new Date(Date.now() - 15*24*60*60*1000).toISOString().split('T')[0])
      if (uid) qReativar = qReativar.eq('unidade_pref', uid)
      const { count: reativar } = await qReativar

      return {
        total: totalAll,
        finalizados: finalizadosAll,
        pendentes: pendentesAll,
        faturamento: faturamentoAll.toFixed(2),
        faturamento_appbarber: abFaturamento.toFixed(2), // sinal: parte já paga no AppBarber (não entra no caixa do sistema)
        ticket: ticket.toFixed(2),
        reativar: reativar || 0
      }
    }

    if (perfil === 'proprietario') {
      // Busca as 3 unidades
      const { data: unidades } = await supabaseAdmin.from('unidades').select('id, nome').order('nome')
      result.metricas_geral = await buildMetricas(null)
      result.metricas_unidades = {}
      for (const u of (unidades || [])) {
        result.metricas_unidades[u.nome] = await buildMetricas(u.id)
      }
    } else {
      result.metricas = await buildMetricas(unidade_id)
    }

    // ---- Agenda do dia ----
    let qAgenda = supabaseAdmin
      .from('agendamentos')
      .select('id, data_hora_ini, data_hora_fim, status, valor, clientes(id, nome, data_nasc), servicos(nome), colaboradores(id, nome, unidade_id, unidades(nome))')
      .gte('data_hora_ini', inicioHoje)
      .lte('data_hora_ini', fimHoje)
      .not('status', 'eq', 'cancelado')
      .order('data_hora_ini')

    if (perfil === 'colaborador') {
      qAgenda = qAgenda.eq('colaborador_id', colab.id)
    } else if (perfil === 'gerente' && unidade_id) {
      qAgenda = qAgenda.eq('unidade_id', unidade_id)
    }
    // proprietario e caixa: veem todos sem filtro de unidade

    const { data: agenda } = await qAgenda
    result.agenda = agenda || []

    // ---- Aniversariantes hoje ----
    const diaHoje = new Date().toISOString().slice(5,10) // MM-DD
    let qAniv = supabaseAdmin.from('clientes')
      .select('id, nome, whatsapp')
      .like('data_nasc', `%-${diaHoje}`)
    if (unidade_id && perfil !== 'proprietario') qAniv = qAniv.eq('unidade_pref', unidade_id)
    const { data: aniversariantes } = await qAniv
    result.aniversariantes = aniversariantes || []

    // ---- Alertas ----
    const alertas = []

    // Planos vencendo em 10 dias
    const em10 = new Date()
    em10.setDate(em10.getDate() + 10)
    let qPlanos = supabaseAdmin.from('assinaturas')
      .select('id, clientes(nome), planos(nome), data_renovacao')
      .eq('status', 'ativa')
      .lte('data_renovacao', em10.toISOString().split('T')[0])
      .gte('data_renovacao', new Date().toISOString().split('T')[0])
    const { data: planosVenc } = await qPlanos
    if (planosVenc?.length) {
      alertas.push({ tipo: 'gold', texto: `${planosVenc.length} plano(s) vencem em 10 dias`, sub: planosVenc.map(p => p.clientes?.nome).join(' · ') })
    }

    result.alertas = alertas

    // ---- Comissões do dia ----
    if (['proprietario','gerente'].includes(perfil)) {
      let qCom = supabaseAdmin.from('agendamentos')
        .select('valor, colaborador_id, colaboradores(id, nome)')
        .gte('data_hora_ini', inicioHoje)
        .lte('data_hora_ini', fimHoje)
        .eq('status', 'concluido')
      if (perfil === 'gerente') qCom = qCom.eq('unidade_id', unidade_id)
      const { data: comAgends } = await qCom

      const comMap = {}
      for (const a of (comAgends || [])) {
        const id   = a.colaborador_id
        const nome = a.colaboradores?.nome || 'Desconhecido'
        if (!comMap[id]) comMap[id] = { nome, total: 0, atendimentos: 0 }
        comMap[id].total       += (parseFloat(a.valor)||0) * 0.4
        comMap[id].atendimentos += 1
      }
      result.comissoes = Object.values(comMap).sort((a,b) => b.total - a.total)
    } else if (perfil === 'colaborador') {
      const { data: minhasComandas } = await supabaseAdmin.from('agendamentos')
        .select('valor, data_hora_ini')
        .eq('colaborador_id', colab.id)
        .eq('status', 'concluido')
        .gte('data_hora_ini', inicioMes)
      const hoje_val  = (minhasComandas||[]).filter(a => a.data_hora_ini >= inicioHoje).reduce((s,a)=>s+(parseFloat(a.valor)||0)*0.4,0)
      const mes_val   = (minhasComandas||[]).reduce((s,a)=>s+(parseFloat(a.valor)||0)*0.4,0)
      result.comissoes = { hoje: hoje_val.toFixed(2), mes: mes_val.toFixed(2), atendimentos_mes: (minhasComandas||[]).length }
    }

    // ---- Top clientes do mês ----
    let qTop = supabaseAdmin.from('agendamentos')
      .select('cliente_id, clientes(nome), colaboradores(nome), unidades(nome)')
      .gte('data_hora_ini', inicioMes)
      .eq('status', 'concluido')
    if (perfil === 'colaborador') qTop = qTop.eq('colaborador_id', colab.id)
    else if (perfil === 'gerente') qTop = qTop.eq('unidade_id', unidade_id)
    const { data: topAgends } = await qTop

    const topMap = {}
    for (const a of (topAgends||[])) {
      const id = a.cliente_id
      if (!topMap[id]) topMap[id] = { nome: a.clientes?.nome, barbeiro: a.colaboradores?.nome, unidade: a.unidades?.nome, visitas: 0 }
      topMap[id].visitas++
    }
    result.top_clientes = Object.values(topMap).sort((a,b)=>b.visitas-a.visitas).slice(0,10)

    return res.json(result)
  } catch (err) {
    console.error('[dashboard]', err)
    return res.status(500).json({ erro: 'Erro ao buscar métricas' })
  }
})

// ============================================================
// GET /dashboard/agenda/:unidade_id
// Agenda completa de uma unidade (para multi-agenda do caixa)
// ============================================================
router.get('/dashboard/agenda/:unidade_id', autenticar, async (req, res) => {
  try {
    const hoje       = new Date()
    const inicioHoje = new Date(hoje.setHours(0,0,0,0)).toISOString()
    const fimHoje    = new Date(hoje.setHours(23,59,59,999)).toISOString()

    const { data } = await supabaseAdmin
      .from('agendamentos')
      .select('id, data_hora_ini, data_hora_fim, status, valor, clientes(id, nome, data_nasc), servicos(nome), colaboradores(id, nome)')
      .eq('unidade_id', req.params.unidade_id)
      .gte('data_hora_ini', inicioHoje)
      .lte('data_hora_ini', fimHoje)
      .order('data_hora_ini')

    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar agenda' })
  }
})

module.exports = router
