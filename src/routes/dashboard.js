const express = require('express')
const router  = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { calcularComissaoFaixa, limitesMes } = require('./comissao-faixa')

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
      .select('id, nome, perfil, unidade_id, comissao_pct, unidades(id, nome)')
      .eq('user_id', usuario.id)
      .single()
    
    if (c1) {
      colab = c1
    } else {
      // Tenta pelo id direto da tabela colaboradores
      const { data: c2 } = await supabaseAdmin
        .from('colaboradores')
        .select('id, nome, perfil, unidade_id, comissao_pct, unidades(id, nome)')
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

    // ---- Comissões do MÊS por faixa (mesmo motor do Caixa e do Relatório) ----
    if (['proprietario','gerente'].includes(perfil)) {
      try {
        const { ini, fim } = limitesMes()
        const uidCom = perfil === 'gerente' ? unidade_id : null
        const fx = await calcularComissaoFaixa({ ini, fim, unidade_id: uidCom })
        result.comissoes = (fx.linhas || []).map(l => ({
          nome: l.nome,
          total: l.comissao_total,
          servico_total: l.servico_total, servico_pct: l.servico_pct,
          produto_total: l.produto_total, produto_unidades: l.produto_unidades, produto_pct: l.produto_pct
        }))
      } catch (e) { console.error('[dashboard comissoes-faixa]', e.message); result.comissoes = [] }
    } else if (perfil === 'colaborador') {
      try {
        const { ini, fim } = limitesMes()
        const fx = await calcularComissaoFaixa({ ini, fim, unidade_id: colab.unidade_id || null })
        const minha = (fx.linhas || []).find(l => l.colaborador_id === colab.id) ||
          { comissao_total: 0, servico_pct: 40, produto_pct: 10, servico_total: 0, produto_total: 0, produto_unidades: 0 }
        // estimativa de hoje: receita de hoje × a faixa do mês
        const fxHoje = await calcularComissaoFaixa({ ini: inicioHoje, fim: fimHoje, unidade_id: colab.unidade_id || null })
        const h = (fxHoje.linhas || []).find(l => l.colaborador_id === colab.id) || { servico_total: 0, produto_total: 0 }
        const hojeVal = h.servico_total * minha.servico_pct / 100 + h.produto_total * minha.produto_pct / 100
        result.comissoes = {
          hoje: hojeVal.toFixed(2),
          mes: Number(minha.comissao_total).toFixed(2),
          pct_servico: minha.servico_pct,
          servico_total: minha.servico_total,
          produto_total: minha.produto_total,
          produto_unidades: minha.produto_unidades
        }
      } catch (e) { console.error('[dashboard comissoes-faixa colab]', e.message); result.comissoes = { hoje: '0.00', mes: '0.00', pct_servico: 40 } }
    }

    // ---- Meu desempenho (barbeiro): hoje + mês ----
    if (perfil === 'colaborador') {
      try {
        const r2 = n => Math.round((n || 0) * 100) / 100
        const desemp = async (ini, fim) => {
          const [abReal, cmdsFin, abAus, abProd, agePend] = await Promise.all([
            supabaseAdmin.from('agenda_appbarber').select('valor, cliente_codigo, cliente_nome')
              .eq('tipo', 'agendamento').is('agendamento_id', null).eq('status', 'realizado')
              .eq('colaborador_id', colab.id).gte('inicio', ini).lte('inicio', fim),
            supabaseAdmin.from('comandas').select('total, cliente_id')
              .eq('status', 'finalizada').eq('colaborador_id', colab.id).gte('finalizada_em', ini).lte('finalizada_em', fim),
            supabaseAdmin.from('agenda_appbarber').select('id')
              .eq('tipo', 'agendamento').eq('status', 'ausente')
              .eq('colaborador_id', colab.id).gte('inicio', ini).lte('inicio', fim),
            supabaseAdmin.from('agenda_appbarber_produtos').select('quantidade, valor_unit')
              .eq('colaborador_id', colab.id).gte('data', ini).lte('data', fim),
            supabaseAdmin.from('agenda_appbarber').select('id')
              .eq('tipo', 'agendamento').is('agendamento_id', null).eq('status', 'agendado')
              .eq('colaborador_id', colab.id).gte('inicio', ini).lte('inicio', fim),
          ])
          const feitos = (abReal.data?.length || 0) + (cmdsFin.data?.length || 0)
          const faltas = (abAus.data?.length || 0)
          const agendados = (agePend.data?.length || 0)
          let prod_qtd = 0, prod_valor = 0
          ;(abProd.data || []).forEach(p => { const q = parseInt(p.quantidade) || 1; prod_qtd += q; prod_valor += (parseFloat(p.valor_unit) || 0) * q })
          const servico_valor = (abReal.data || []).reduce((s, a) => s + (parseFloat(a.valor) || 0), 0) +
                                (cmdsFin.data || []).reduce((s, c) => s + (parseFloat(c.total) || 0), 0)
          const geral = servico_valor + prod_valor
          const cli = new Set()
          ;(abReal.data || []).forEach(a => cli.add(a.cliente_codigo || ('n:' + (a.cliente_nome || '?'))))
          ;(cmdsFin.data || []).forEach(c => { if (c.cliente_id) cli.add('c:' + c.cliente_id) })
          return { feitos, agendados, faltas, prod_qtd, prod_valor: r2(prod_valor), servico_valor: r2(servico_valor), geral: r2(geral), ticket: feitos > 0 ? r2(geral / feitos) : 0, _cli: cli }
        }
        const dHoje = await desemp(inicioHoje, fimHoje)
        const dMes  = await desemp(inicioMes, fimHoje)
        // novos x recorrentes (mês): cliente que NÃO apareceu antes do mês = novo
        let novos = 0, recorrentes = 0
        try {
          const { data: antes } = await supabaseAdmin.from('agenda_appbarber')
            .select('cliente_codigo, cliente_nome')
            .eq('tipo', 'agendamento').eq('status', 'realizado').eq('colaborador_id', colab.id)
            .lt('inicio', inicioMes)
          const antesSet = new Set((antes || []).map(a => a.cliente_codigo || ('n:' + (a.cliente_nome || '?'))))
          dMes._cli.forEach(k => { if (antesSet.has(k)) recorrentes++; else novos++ })
        } catch (e) {}
        const limpar = d => ({ feitos: d.feitos, agendados: d.agendados, faltas: d.faltas, prod_qtd: d.prod_qtd, prod_valor: d.prod_valor, servico_valor: d.servico_valor, geral: d.geral, ticket: d.ticket, clientes: d._cli.size })
        result.desempenho = { hoje: limpar(dHoje), mes: { ...limpar(dMes), clientes_novos: novos, clientes_recorrentes: recorrentes } }
      } catch (e) { console.error('[dashboard desempenho]', e.message) }
    }

    // ---- Top clientes do mês (comandas finalizadas + AppBarber realizado) ----
    const topMap = {}
    const addTop = (key, nome, unidade, barbeiro) => {
      if (!key) return
      if (!topMap[key]) topMap[key] = { nome: nome || 'Cliente', unidade: unidade || null, barbeiro: barbeiro || null, visitas: 0 }
      if (nome && (!topMap[key].nome || topMap[key].nome === 'Cliente')) topMap[key].nome = nome
      if (unidade && !topMap[key].unidade) topMap[key].unidade = unidade
      if (barbeiro && !topMap[key].barbeiro) topMap[key].barbeiro = barbeiro
      topMap[key].visitas++
    }

    let qTopC = supabaseAdmin.from('comandas')
      .select('cliente_id, clientes(nome), colaboradores(nome), unidades(nome)')
      .eq('status', 'finalizada').gte('finalizada_em', inicioMes).not('cliente_id', 'is', null)
    if (perfil === 'colaborador') qTopC = qTopC.eq('colaborador_id', colab.id)
    else if (perfil === 'gerente') qTopC = qTopC.eq('unidade_id', unidade_id)
    const { data: topCmds } = await qTopC
    for (const c of (topCmds || [])) addTop(c.cliente_id, c.clientes?.nome, c.unidades?.nome, c.colaboradores?.nome)

    let qTopAB = supabaseAdmin.from('agenda_appbarber')
      .select('cliente_id, cliente_nome')
      .eq('tipo', 'agendamento').is('agendamento_id', null).eq('status', 'realizado')
      .gte('inicio', inicioMes)
    if (perfil === 'colaborador') qTopAB = qTopAB.eq('colaborador_id', colab.id)
    else if (perfil === 'gerente') qTopAB = qTopAB.eq('unidade_id', unidade_id)
    const { data: topAB } = await qTopAB
    for (const a of (topAB || [])) addTop(a.cliente_id || ('n:' + (a.cliente_nome || '?')), a.cliente_nome, null, null)

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
