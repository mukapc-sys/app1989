const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

// ============================================================
// Status que OCUPAM o horário de um barbeiro.
//
// 'concluido' PRECISA estar aqui. Sem ele, um cliente atendido mais cedo
// LIBERAVA o próprio horário: às 16h o barbeiro finalizava o atendimento
// das 17h, e as 17h voltavam a ser oferecidas — outro cliente marcava em
// cima. (Bug real, 13/07/2026.)
// 'bloqueado' idem: folga/bloqueio na agenda também ocupa.
// ============================================================
const STATUS_OCUPA_HORARIO = ['agendado', 'confirmado', 'andamento', 'concluido', 'bloqueado']

// ---- Realtime: avisa "agenda mudou" (broadcast, SEM dados de cliente) ----
async function pingAgenda(unidade_id) {
  try {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    if (!url || !key) return
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ messages: [{ topic: 'agenda', event: 'mudou', payload: { unidade_id: unidade_id || null, at: Date.now() } }] }),
    })
  } catch (e) { console.error('[ping agenda]', e.message) }
}
// GET /agendamentos/hoje?unidade_id=xxx
// Retorna agenda do dia — todos os perfis (filtrado por permissão)
router.get('/hoje', autenticar, async (req, res) => {
  try {
    const { unidade_id } = req.query
    const u = req.usuario
    const hoje = new Date()
    const ini = new Date(hoje.setHours(0,0,0,0)).toISOString()
    const fim = new Date(hoje.setHours(23,59,59,999)).toISOString()
    let query = supabaseAdmin
      .from('vw_agenda_dia')
      .select('*')
      .gte('data_hora_ini', ini)
      .lte('data_hora_ini', fim)
      .order('data_hora_ini')
    // Barbeiro colaborador só vê a própria agenda + colegas da unidade
    if (u.perfil === 'colaborador') {
      query = query.eq('unidade_id', u.unidade_id)
    } else if (u.perfil === 'gerente') {
      query = query.eq('unidade_id', u.unidade_id)
    } else if (['proprietario', 'caixa'].includes(u.perfil) && unidade_id) {
      query = query.eq('unidade_id', unidade_id)
    }
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao buscar agenda' })
  }
})
// GET /agendamentos?data=2025-05-15&colaborador_id=xxx
router.get('/', autenticar, async (req, res) => {
  try {
    const { data, colaborador_id, unidade_id, status } = req.query
    const u = req.usuario
    let query = supabaseAdmin
      .from('vw_agenda_dia')
      .select('*')
      .order('data_hora_ini')
    if (data) {
      const ini = new Date(data + 'T00:00:00').toISOString()
      const fim = new Date(data + 'T23:59:59').toISOString()
      query = query.gte('data_hora_ini', ini).lte('data_hora_ini', fim)
    }
    if (colaborador_id) query = query.eq('colaborador_id', colaborador_id)
    if (unidade_id)     query = query.eq('unidade_id', unidade_id)
    if (status)         query = query.eq('status', status)
    // Restrição por perfil
    if (u.perfil === 'colaborador') query = query.eq('unidade_id', u.unidade_id)
    if (u.perfil === 'gerente')     query = query.eq('unidade_id', u.unidade_id)
    if (u.perfil === 'cliente') {
      const { data: cli } = await supabaseAdmin.from('clientes').select('id').eq('user_id', u.user_id).single()
      if (cli) query = query.eq('cliente_id', cli.id)
    }
    const { data: rows, error } = await query
    if (error) throw error
    return res.json(rows)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao buscar agendamentos' })
  }
})
// GET /agendamentos/horarios-disponiveis?colaborador_id=xxx&data=2025-05-15&duracao=30
router.get('/horarios-disponiveis', autenticar, async (req, res) => {
  try {
    const { colaborador_id, data, duracao = 30 } = req.query
    if (!colaborador_id || !data) {
      return res.status(400).json({ erro: 'colaborador_id e data são obrigatórios' })
    }
    // Busca agendamentos e bloqueios do dia para o colaborador
    const ini = new Date(data + 'T00:00:00').toISOString()
    const fim = new Date(data + 'T23:59:59').toISOString()
    const [{ data: ocupados }, { data: bloqueios }] = await Promise.all([
      supabaseAdmin.from('agendamentos')
        .select('data_hora_ini, data_hora_fim')
        .eq('colaborador_id', colaborador_id)
        // inclui 'concluido': atendimento finalizado NÃO libera o horário dele
        .in('status', STATUS_OCUPA_HORARIO)
        .gte('data_hora_ini', ini).lte('data_hora_ini', fim),
      supabaseAdmin.from('bloqueios')
        .select('data_ini, data_fim')
        .eq('colaborador_id', colaborador_id)
        .gte('data_ini', ini).lte('data_ini', fim)
    ])
    // Horário de funcionamento por dia da semana:
    //  Seg-Sex: 10h-20h · Sábado: 9h-18h · Domingo: fechado
    const partesData = String(data).split('-').map(Number)
    const dow = new Date(Date.UTC(partesData[0], partesData[1] - 1, partesData[2])).getUTCDay() // 0=Dom ... 6=Sáb
    let inicio, fimDia
    if (dow === 0) {
      // Domingo fechado -> não gera nenhum slot
      return res.json([])
    } else if (dow === 6) {
      inicio = 9 * 60; fimDia = 18 * 60   // Sábado
    } else {
      inicio = 10 * 60; fimDia = 20 * 60  // Seg-Sex
    }
    const slots = []
    const passo = 30
    for (let min = inicio; min + parseInt(duracao) <= fimDia; min += passo) {
      const slotIni = new Date(data + 'T00:00:00')
      slotIni.setMinutes(slotIni.getMinutes() + min)
      const slotFim = new Date(slotIni)
      slotFim.setMinutes(slotFim.getMinutes() + parseInt(duracao))
      // Verifica conflito com agendamentos
      const ocupado = (ocupados || []).some(ag => {
        const agIni = new Date(ag.data_hora_ini)
        const agFim = new Date(ag.data_hora_fim)
        return slotIni < agFim && slotFim > agIni
      })
      // Verifica conflito com bloqueios
      const bloqueado = (bloqueios || []).some(bl => {
        const blIni = new Date(bl.data_ini)
        const blFim = new Date(bl.data_fim)
        return slotIni < blFim && slotFim > blIni
      })
      const hora = `${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`
      slots.push({ hora, disponivel: !ocupado && !bloqueado, data_hora: slotIni.toISOString() })
    }
    return res.json(slots)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao buscar horários' })
  }
})
// POST /agendamentos
router.post('/', autenticar, async (req, res) => {
  try {
    const { colaborador_id, cliente_id, cliente_nome, servico_id, unidade_id, data_hora_ini, observacao } = req.body
    if (!colaborador_id || !servico_id || !unidade_id || !data_hora_ini) {
      return res.status(400).json({ erro: 'Campos obrigatórios: colaborador_id, servico_id, unidade_id, data_hora_ini' })
    }
    // Busca duração do serviço
    const { data: servico } = await supabaseAdmin
      .from('servicos').select('duracao_min, valor, nome').eq('id', servico_id).single()
    if (!servico) return res.status(404).json({ erro: 'Serviço não encontrado' })
    // TEMPO DE ATENDIMENTO: quem está agendando (caixa, gerente ou barbeiro) pode
    // definir a duração — o mesmo "cabelo e barba" leva 15 ou 45 min dependendo do
    // cliente, e quem está na barbearia sabe melhor que o cadastro.
    // Se não vier nada no body, usa a duração padrão do serviço.
    // ⚠️ IMPORTANTE: a duração escolhida entra AQUI, antes da checagem de conflito.
    // Antes o `fim` era sempre calculado com a duração do CADASTRO: quem agendasse
    // 60 min num serviço de 30 tinha o conflito checado só nos primeiros 30 min e
    // podia sobrepor o cliente seguinte sem aviso.
    let dur = parseInt(req.body.duracao || req.body.duracao_min, 10)
    if (!dur || isNaN(dur) || dur < 5 || dur > 480) dur = servico.duracao_min || 30
    const ini = new Date(data_hora_ini)
    const fim = new Date(ini.getTime() + dur * 60000)
    // ENCAIXE é a exceção: sobrepõe qualquer horário (agendamento existente,
    // antes de abrir, depois de fechar). Só valida conflito quando NÃO é encaixe.
    const ehEncaixe = !!(req.body.encaixe)
    if (!ehEncaixe) {
      const { data: conflito } = await supabaseAdmin
        .from('agendamentos')
        .select('id')
        .eq('colaborador_id', colaborador_id)
        // inclui 'concluido': horário já atendido continua ocupado
        .in('status', STATUS_OCUPA_HORARIO)
        .lt('data_hora_ini', fim.toISOString())
        .gt('data_hora_fim', ini.toISOString())
      if (conflito && conflito.length > 0) {
        return res.status(409).json({ erro: 'Horário já ocupado para este profissional' })
      }
    }
    const { data: novo, error } = await supabaseAdmin
      .from('agendamentos')
      .insert({
        colaborador_id,
        cliente_id:    cliente_id || null,
        cliente_nome:  cliente_nome || null,
        servico_id,
        unidade_id,
        data_hora_ini: ini.toISOString(),
        data_hora_fim: fim.toISOString(),
        valor:         servico.valor,
        observacao:    observacao || null,
        encaixe:       ehEncaixe,
        status:        'agendado',
        canal_origem:  req.usuario.perfil === 'cliente' ? 'pwa' : 'sistema',
        criado_por:    req.usuario.perfil !== 'cliente' ? req.usuario.id : null
      })
      .select()
      .single()
    if (error) throw error
    pingAgenda(unidade_id)
    return res.status(201).json(novo)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao criar agendamento' })
  }
})
// PUT /agendamentos/:id/status
router.put('/:id/status', autenticar, async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body
    const u = req.usuario
    const statusValidos = ['agendado','confirmado','andamento','concluido','cancelado','nao_compareceu']
    if (!statusValidos.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido' })
    }
    // Colaborador só pode alterar status dos próprios agendamentos
    const { data: ag } = await supabaseAdmin.from('agendamentos').select('colaborador_id').eq('id', id).single()
    if (!ag) return res.status(404).json({ erro: 'Agendamento não encontrado' })
    if (u.perfil === 'colaborador' && ag.colaborador_id !== u.id) {
      return res.status(403).json({ erro: 'Sem permissão para alterar este agendamento' })
    }
    const { data, error } = await supabaseAdmin
      .from('agendamentos').update({ status }).eq('id', id).select().single()
    if (error) throw error
    pingAgenda(data && data.unidade_id)
    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao atualizar agendamento' })
  }
})
// ITEM 3 — alterar a duração (tempo de atendimento) de um agendamento.
// body: { duracao } em minutos. Recalcula data_hora_fim a partir do início.
router.put('/:id/duracao', autenticar, async (req, res) => {
  try {
    const { id } = req.params
    const dur = parseInt(req.body && req.body.duracao)
    const u = req.usuario
    if (!dur || dur < 5 || dur > 480) {
      return res.status(400).json({ erro: 'Informe uma duração entre 5 e 480 minutos.' })
    }
    const { data: ag } = await supabaseAdmin.from('agendamentos')
      .select('colaborador_id, data_hora_ini, unidade_id').eq('id', id).single()
    if (!ag) return res.status(404).json({ erro: 'Agendamento não encontrado' })
    // Colaborador só altera os próprios; gerente/caixa/proprietário podem todos.
    if (u.perfil === 'colaborador' && ag.colaborador_id !== u.id) {
      return res.status(403).json({ erro: 'Sem permissão para alterar este agendamento' })
    }
    const ini = new Date(ag.data_hora_ini)
    const fim = new Date(ini.getTime() + dur * 60000)
    const { data, error } = await supabaseAdmin
      .from('agendamentos').update({ data_hora_fim: fim.toISOString() }).eq('id', id).select().single()
    if (error) throw error
    pingAgenda(data && data.unidade_id)
    return res.json({ ok: true, duracao: dur, data_hora_fim: fim.toISOString() })
  } catch (err) {
    console.error('[agendamentos/duracao]', err.message)
    return res.status(500).json({ erro: 'Erro ao alterar tempo de atendimento' })
  }
})
module.exports = router
