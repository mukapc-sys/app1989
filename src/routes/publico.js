// ============================================================
//  ROTAS PÚBLICAS (sem login) — usadas pelo front do cliente
//  (agendar.barbearia1989.com.br)
//  Não exigem token. Mantêm validação para evitar abuso básico.
// ============================================================
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')

// ---- WhatsApp: pronto para a Evolution API (no-op se não configurada) ----
async function enviarWhatsApp(numero, texto) {
  try {
    const url  = process.env.EVOLUTION_API_URL
    const key  = process.env.EVOLUTION_API_KEY
    const inst = process.env.EVOLUTION_INSTANCE
    if (!url || !key || !inst) {
      console.log('[wpp] Evolution não configurada — confirmação não enviada (ok)')
      return false
    }
    let n = String(numero).replace(/\D/g, '')
    if (!n.startsWith('55')) n = '55' + n
    await fetch(`${url}/message/sendText/${inst}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': key },
      body: JSON.stringify({ number: n, text: texto }),
    })
    return true
  } catch (e) {
    console.error('[wpp]', e.message)
    return false
  }
}

// ============================================================
// GET /publico/barbeiros — barbeiros ativos (com foto e unidade)
// ============================================================
router.get('/barbeiros', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('colaboradores')
      .select('id,nome,foto_url,perfil,ativo,unidade_id,unidades(nome)')
      .eq('ativo', true).order('nome')
    if (error) throw error
    return res.json((data || []).filter(c => c.perfil !== 'caixa'))
  } catch (e) {
    console.error('[publico/barbeiros]', e.message)
    return res.status(500).json({ erro: 'Erro ao listar barbeiros' })
  }
})

// ============================================================
// GET /publico/servicos?colaborador_id= — serviços do barbeiro (online)
// Se o barbeiro não tiver serviços configurados, mostra todos os online.
// ============================================================
router.get('/servicos', async (req, res) => {
  try {
    const { colaborador_id } = req.query
    let ids = null
    if (colaborador_id) {
      const { data: vinc } = await supabaseAdmin
        .from('colaborador_servicos').select('servico_id').eq('colaborador_id', colaborador_id)
      const linkIds = (vinc || []).map(v => v.servico_id)
      if (linkIds.length) ids = linkIds   // só filtra se o barbeiro tiver serviços configurados
    }

    let q = supabaseAdmin.from('servicos')
      .select('id,nome,duracao_min,valor,disponivel_online,ativo')
      .eq('ativo', true).eq('disponivel_online', true).order('nome')
    if (ids) q = q.in('id', ids)

    const { data, error } = await q
    if (error) throw error
    let result = data || []

    // tempo de cada serviço para ESTE barbeiro (sobrepõe a duração padrão)
    if (colaborador_id && result.length) {
      const { data: tempos } = await supabaseAdmin
        .from('colaborador_servico_tempo').select('servico_id,duracao_min').eq('colaborador_id', colaborador_id)
      const tmap = {}
      ;(tempos || []).forEach(t => { tmap[t.servico_id] = t.duracao_min })
      result = result.map(s => Object.assign({}, s, { duracao_min: tmap[s.id] || s.duracao_min }))
    }
    return res.json(result)
  } catch (e) {
    console.error('[publico/servicos]', e.message)
    return res.status(500).json({ erro: 'Erro ao listar serviços' })
  }
})

// ============================================================
// GET /publico/horarios?colaborador_id=&data=&duracao= — slots livres
// ============================================================
router.get('/horarios', async (req, res) => {
  try {
    const { colaborador_id, data, duracao = 30 } = req.query
    if (!colaborador_id || !data) {
      return res.status(400).json({ erro: 'colaborador_id e data são obrigatórios' })
    }
    const ini = new Date(data + 'T00:00:00').toISOString()
    const fim = new Date(data + 'T23:59:59').toISOString()

    const [{ data: ocupados }, { data: bloqueios }] = await Promise.all([
      supabaseAdmin.from('agendamentos')
        .select('data_hora_ini, data_hora_fim')
        .eq('colaborador_id', colaborador_id)
        .in('status', ['agendado', 'confirmado', 'andamento'])
        .gte('data_hora_ini', ini).lte('data_hora_ini', fim),
      supabaseAdmin.from('bloqueios')
        .select('data_ini, data_fim')
        .eq('colaborador_id', colaborador_id)
        .gte('data_ini', ini).lte('data_ini', fim),
    ])

    const slots = []
    const inicio = 8 * 60, fimDia = 20 * 60, passo = 30
    const agora = new Date()
    const dur = parseInt(duracao) || 30

    for (let min = inicio; min + dur <= fimDia; min += passo) {
      const slotIni = new Date(data + 'T00:00:00')
      slotIni.setMinutes(slotIni.getMinutes() + min)
      const slotFim = new Date(slotIni)
      slotFim.setMinutes(slotFim.getMinutes() + dur)

      const ocupado = (ocupados || []).some(a => {
        const i = new Date(a.data_hora_ini), f = new Date(a.data_hora_fim)
        return slotIni < f && slotFim > i
      })
      const bloqueado = (bloqueios || []).some(b => {
        const i = new Date(b.data_ini), f = new Date(b.data_fim)
        return slotIni < f && slotFim > i
      })
      const passou = slotIni < agora

      const hora = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
      slots.push({ hora, disponivel: !ocupado && !bloqueado && !passou, data_hora: slotIni.toISOString() })
    }
    return res.json(slots)
  } catch (e) {
    console.error('[publico/horarios]', e.message)
    return res.status(500).json({ erro: 'Erro ao buscar horários' })
  }
})

// ============================================================
// POST /publico/agendar — cria o agendamento do cliente
// body: { nome, whatsapp, colaborador_id, servico_id, data_hora }
// ============================================================
router.post('/agendar', async (req, res) => {
  try {
    const { nome, whatsapp, colaborador_id, servico_id, data_hora } = req.body || {}
    if (!nome || !whatsapp || !colaborador_id || !servico_id || !data_hora) {
      return res.status(400).json({ erro: 'Preencha nome, WhatsApp, barbeiro, serviço e horário' })
    }

    // barbeiro -> unidade
    const { data: col } = await supabaseAdmin.from('colaboradores')
      .select('id,unidade_id,nome,ativo').eq('id', colaborador_id).single()
    if (!col || !col.ativo) return res.status(400).json({ erro: 'Barbeiro indisponível' })

    // serviço -> duração/valor
    const { data: sv } = await supabaseAdmin.from('servicos')
      .select('id,nome,duracao_min,valor').eq('id', servico_id).single()
    if (!sv) return res.status(400).json({ erro: 'Serviço inválido' })

    const ini = new Date(data_hora)
    if (isNaN(ini.getTime())) return res.status(400).json({ erro: 'Horário inválido' })
    if (ini < new Date()) return res.status(400).json({ erro: 'Esse horário já passou' })
    const fim = new Date(ini)
    fim.setMinutes(fim.getMinutes() + (sv.duracao_min || 30))

    // evita dois clientes no mesmo horário do mesmo barbeiro
    const { data: conflito } = await supabaseAdmin.from('agendamentos')
      .select('id').eq('colaborador_id', colaborador_id)
      .in('status', ['agendado', 'confirmado', 'andamento'])
      .lt('data_hora_ini', fim.toISOString()).gt('data_hora_fim', ini.toISOString())
    if (conflito && conflito.length) {
      return res.status(409).json({ erro: 'Esse horário acabou de ser ocupado. Escolha outro, por favor.' })
    }

    // cliente: acha por WhatsApp (últimos 8 dígitos) ou cria
    const tel = String(whatsapp).replace(/\D/g, '')
    let cliente_id = null
    if (tel.length >= 8) {
      const { data: achados } = await supabaseAdmin.from('clientes')
        .select('id').ilike('whatsapp', '%' + tel.slice(-8) + '%').limit(1)
      if (achados && achados.length) cliente_id = achados[0].id
    }
    if (!cliente_id) {
      const { data: novo, error: ec } = await supabaseAdmin.from('clientes')
        .insert({ nome: String(nome).trim(), whatsapp: tel, origem: 'online', unidade_pref: col.unidade_id, ativo: true })
        .select('id').single()
      if (ec) throw ec
      cliente_id = novo.id
    }

    // cria o agendamento
    const { data: ag, error: ea } = await supabaseAdmin.from('agendamentos').insert({
      data_hora_ini: ini.toISOString(),
      data_hora_fim: fim.toISOString(),
      status: 'agendado',
      valor: sv.valor || 0,
      canal_origem: 'online',
      colaborador_id,
      unidade_id: col.unidade_id,
      cliente_id,
      servico_id,
    }).select('id').single()
    if (ea) throw ea

    // confirmação no WhatsApp (pronto p/ Evolution; não quebra se não tiver)
    const quando = ini.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })
    const primeiro = String(nome).trim().split(' ')[0]
    enviarWhatsApp(tel, `Olá ${primeiro}! Seu horário na Barbearia 1989 está marcado: ${sv.nome} com ${col.nome} em ${quando}. Até já! ✂️`)

    return res.json({ ok: true, agendamento_id: ag.id })
  } catch (e) {
    console.error('[publico/agendar]', e.message)
    return res.status(500).json({ erro: 'Erro ao agendar', detalhe: e.message })
  }
})

// ============================================================
// GET /publico/meus-agendamentos?whatsapp= — agendamentos do cliente
// ============================================================
router.get('/meus-agendamentos', async (req, res) => {
  try {
    const tel = String(req.query.whatsapp || '').replace(/\D/g, '')
    if (tel.length < 8) return res.status(400).json({ erro: 'WhatsApp inválido' })

    const { data: cli } = await supabaseAdmin.from('clientes')
      .select('id').ilike('whatsapp', '%' + tel.slice(-8) + '%').limit(1)
    if (!cli || !cli.length) return res.json([])

    const { data, error } = await supabaseAdmin.from('agendamentos')
      .select('id,data_hora_ini,data_hora_fim,status,valor,servicos(nome),colaboradores(nome),unidades(nome)')
      .eq('cliente_id', cli[0].id)
      .order('data_hora_ini', { ascending: false })
      .limit(30)
    if (error) throw error
    return res.json(data || [])
  } catch (e) {
    console.error('[publico/meus-agendamentos]', e.message)
    return res.status(500).json({ erro: 'Erro ao buscar agendamentos' })
  }
})

module.exports = router
