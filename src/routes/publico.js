// ============================================================
//  ROTAS PÚBLICAS (sem login) — usadas pelo front do cliente
//  (agendar.barbearia1989.com.br)
//  Não exigem token. Mantêm validação para evitar abuso básico.
// ============================================================
const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { supabaseAdmin } = require('../config/supabase')

// ---- Token do cliente (mesmo JWT_SECRET do sistema) ----
// Horário de funcionamento da barbearia (minutos desde 00:00). Retorna null se fechado.
//  Seg-Sex: 10h-20h · Sábado e feriados: 9h-18h · Domingo: fechado
function horarioFuncionamento(dataStr, ehFeriado) {
  const partes = String(dataStr).split('-').map(Number)
  const dow = new Date(Date.UTC(partes[0], partes[1] - 1, partes[2])).getUTCDay() // 0=Dom ... 6=Sáb
  if (dow === 0) return null                                   // Domingo fechado
  if (ehFeriado || dow === 6) return { abre: 9 * 60, fecha: 18 * 60 } // Sábado/feriado
  return { abre: 10 * 60, fecha: 20 * 60 }                     // Seg-Sex
}
// Converte 'HH:MM' em minutos desde 00:00 (ex.: '09:30' -> 570)
function hmToMin(hm) {
  const p = String(hm || '').split(':'); const h = parseInt(p[0], 10) || 0; const m = parseInt(p[1], 10) || 0
  return h * 60 + m
}

function tokenCliente(c) {
  return jwt.sign({ id: c.id, tipo: 'cliente', nome: c.nome }, process.env.JWT_SECRET, { expiresIn: '30d' })
}
function autenticarCliente(req, res, next) {
  try {
    const h = req.headers.authorization || ''
    const t = h.replace('Bearer ', '').trim()
    if (!t) return res.status(401).json({ erro: 'Faça login' })
    const d = jwt.verify(t, process.env.JWT_SECRET)
    if (d.tipo !== 'cliente') return res.status(401).json({ erro: 'Token inválido' })
    req.cliente = { id: d.id, nome: d.nome }
    next()
  } catch (e) {
    return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' })
  }
}

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
      .select('id,nome,foto_url,foto_url_2,perfil,ativo,unidade_id,unidades(nome)')
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
    const ini = new Date(data + 'T00:00:00-03:00').toISOString()
    const fim = new Date(data + 'T23:59:59-03:00').toISOString()

    const [{ data: ocupados }, { data: bloqueios }, { data: importados }, { data: feriados }] = await Promise.all([
      supabaseAdmin.from('agendamentos')
        .select('data_hora_ini, data_hora_fim')
        .eq('colaborador_id', colaborador_id)
        .in('status', ['agendado', 'confirmado', 'andamento', 'bloqueado'])
        .gte('data_hora_ini', ini).lte('data_hora_ini', fim),
      supabaseAdmin.from('bloqueios')
        .select('data_ini, data_fim')
        .eq('colaborador_id', colaborador_id)
        .gte('data_ini', ini).lte('data_ini', fim),
      // importados do AppBarber ainda não finalizados (agendamentos E bloqueios ocupam o horário)
      supabaseAdmin.from('agenda_appbarber')
        .select('inicio, fim')
        .eq('colaborador_id', colaborador_id)
        .eq('finalizado', false)
        .gte('inicio', ini).lte('inicio', fim),
      // feriados cadastrados nessa data (afetam o horário de funcionamento)
      supabaseAdmin.from('feriados').select('*').eq('data', data),
    ])

    // Horário de funcionamento do dia (feriado manda; senão, dia da semana)
    const fer = (feriados || [])[0]
    let hf
    if (fer) {
      if (fer.fechado) hf = null                                              // feriado fechado
      else if (fer.hora_abre && fer.hora_fecha) hf = { abre: hmToMin(fer.hora_abre), fecha: hmToMin(fer.hora_fecha) } // personalizado
      else hf = { abre: 9 * 60, fecha: 18 * 60 }                              // feriado padrão 9h-18h
    } else {
      hf = horarioFuncionamento(data, false)
    }
    const inicio = hf ? hf.abre : 0
    const fimDia = hf ? hf.fecha : 0   // fechado -> inicio=fimDia=0 -> não gera nenhum slot
    const passo = 15
    const agora = new Date()
    const dur = parseInt(duracao) || 30

    const slots = []
    for (let min = inicio; min + dur <= fimDia; min += passo) {
      const hh = String(Math.floor(min / 60)).padStart(2, '0')
      const mm = String(min % 60).padStart(2, '0')
      const slotIni = new Date(`${data}T${hh}:${mm}:00-03:00`)
      const slotFim = new Date(slotIni.getTime() + dur * 60000)

      const ocupado = (ocupados || []).some(a => {
        const i = new Date(a.data_hora_ini), f = new Date(a.data_hora_fim)
        return slotIni < f && slotFim > i
      })
      const bloqueado = (bloqueios || []).some(b => {
        const i = new Date(b.data_ini), f = new Date(b.data_fim)
        return slotIni < f && slotFim > i
      })
      const importadoOcupa = (importados || []).some(a => {
        const i = new Date(a.inicio), f = new Date(a.fim)
        return slotIni < f && slotFim > i
      })
      const passou = slotIni < agora

      const hora = `${hh}:${mm}`
      slots.push({ hora, disponivel: !ocupado && !bloqueado && !importadoOcupa && !passou, data_hora: slotIni.toISOString() })
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

    // valida o horário de funcionamento (dia da semana + feriado), em horário de Brasília
    const _p = {}
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(ini).forEach(p => { _p[p.type] = p.value })
    const dataBR = `${_p.year}-${_p.month}-${_p.day}`
    let _hh = parseInt(_p.hour); if (_hh === 24) _hh = 0
    const minDia = _hh * 60 + parseInt(_p.minute)
    const { data: ferAg } = await supabaseAdmin.from('feriados').select('*').eq('data', dataBR)
    const _fa = (ferAg || [])[0]
    let hfAg
    if (_fa) {
      if (_fa.fechado) hfAg = null
      else if (_fa.hora_abre && _fa.hora_fecha) hfAg = { abre: hmToMin(_fa.hora_abre), fecha: hmToMin(_fa.hora_fecha) }
      else hfAg = { abre: 9 * 60, fecha: 18 * 60 }
    } else {
      hfAg = horarioFuncionamento(dataBR, false)
    }
    const durAg = sv.duracao_min || 30
    if (!hfAg || minDia < hfAg.abre || minDia + durAg > hfAg.fecha) {
      return res.status(400).json({ erro: 'Esse horário está fora do funcionamento da barbearia' })
    }
    const fim = new Date(ini)
    fim.setMinutes(fim.getMinutes() + (sv.duracao_min || 30))

    // evita dois clientes no mesmo horário do mesmo barbeiro (inclui bloqueios e importados)
    const [{ data: conflito }, { data: confImport }] = await Promise.all([
      supabaseAdmin.from('agendamentos')
        .select('id').eq('colaborador_id', colaborador_id)
        .in('status', ['agendado', 'confirmado', 'andamento', 'bloqueado'])
        .lt('data_hora_ini', fim.toISOString()).gt('data_hora_fim', ini.toISOString()),
      supabaseAdmin.from('agenda_appbarber')
        .select('id').eq('colaborador_id', colaborador_id)
        .eq('finalizado', false)
        .lt('inicio', fim.toISOString()).gt('fim', ini.toISOString()),
    ])
    if ((conflito && conflito.length) || (confImport && confImport.length)) {
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

    // avisa as agendas abertas (Realtime) que algo mudou
    pingAgenda(col.unidade_id)

    // confirmação no WhatsApp (pronto p/ Evolution; não quebra se não tiver)
    const quando = ini.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })
    const primeiro = String(nome).trim().split(' ')[0]
    enviarWhatsApp(tel, `Olá ${primeiro}! Seu horário na Barbearia 1989 está marcado: ${sv.nome} com ${col.nome} em ${quando}. Até já! ✂️`)

    // confirmação por push (se o cliente tiver notificações ativas no app)
    enviarPushParaCliente(cliente_id, {
      titulo: 'Agendamento confirmado ✂️',
      corpo: `${sv.nome} com ${col.nome} — ${quando}`,
      url: 'https://barbearia1989.com.br'
    }).catch(() => {})

    return res.json({ ok: true, agendamento_id: ag.id })
  } catch (e) {
    console.error('[publico/agendar]', e.message)
    return res.status(500).json({ erro: 'Erro ao agendar', detalhe: e.message })
  }
})

// ============================================================
// GET /publico/meus-agendamentos — agendamentos do cliente
// Usa o login (token) se houver; senão aceita ?whatsapp=
// ============================================================
router.get('/meus-agendamentos', async (req, res) => {
  try {
    let cliente_id = null
    // tenta pelo token (cliente logado)
    const h = req.headers.authorization || ''
    const t = h.replace('Bearer ', '').trim()
    if (t) {
      try {
        const d = jwt.verify(t, process.env.JWT_SECRET)
        if (d.tipo === 'cliente') cliente_id = d.id
      } catch (_) { /* token inválido -> tenta whatsapp */ }
    }
    // senão, pelo WhatsApp
    if (!cliente_id) {
      const tel = String(req.query.whatsapp || '').replace(/\D/g, '')
      if (tel.length < 8) return res.status(400).json({ erro: 'WhatsApp inválido' })
      const { data: cli } = await supabaseAdmin.from('clientes')
        .select('id').ilike('whatsapp', '%' + tel.slice(-8) + '%').limit(1)
      if (!cli || !cli.length) return res.json([])
      cliente_id = cli[0].id
    }

    const { data, error } = await supabaseAdmin.from('agendamentos')
      .select('id,data_hora_ini,data_hora_fim,status,valor,servicos(nome),colaboradores(nome),unidades(nome)')
      .eq('cliente_id', cliente_id)
      .order('data_hora_ini', { ascending: false })
      .limit(30)
    if (error) throw error
    return res.json(data || [])
  } catch (e) {
    console.error('[publico/meus-agendamentos]', e.message)
    return res.status(500).json({ erro: 'Erro ao buscar agendamentos' })
  }
})

// ============================================================
// POST /publico/registrar — cria conta do cliente (nome, whatsapp, senha)
// ============================================================
router.post('/registrar', async (req, res) => {
  try {
    const { nome, whatsapp, senha } = req.body || {}
    if (!nome || !whatsapp || !senha) return res.status(400).json({ erro: 'Preencha nome, WhatsApp e senha' })
    if (String(senha).length < 4) return res.status(400).json({ erro: 'A senha precisa de pelo menos 4 caracteres' })
    const tel = String(whatsapp).replace(/\D/g, '')
    if (tel.length < 10) return res.status(400).json({ erro: 'WhatsApp inválido (use DDD + número)' })

    const hash = bcrypt.hashSync(String(senha), 10)

    // já existe um cliente com esse WhatsApp?
    const { data: achados } = await supabaseAdmin.from('clientes')
      .select('id,nome,whatsapp,senha_hash').ilike('whatsapp', '%' + tel.slice(-8) + '%').limit(1)

    let cli
    if (achados && achados.length) {
      cli = achados[0]
      if (cli.senha_hash) return res.status(409).json({ erro: 'Já existe uma conta com esse WhatsApp. Faça login.' })
      // cliente já existia (criou agendando antes) e ainda não tinha senha -> define agora
      const { data: up, error: eu } = await supabaseAdmin.from('clientes')
        .update({ nome: String(nome).trim(), senha_hash: hash }).eq('id', cli.id)
        .select('id,nome,whatsapp').single()
      if (eu) throw eu
      cli = up
    } else {
      const { data: novo, error: en } = await supabaseAdmin.from('clientes')
        .insert({ nome: String(nome).trim(), whatsapp: tel, senha_hash: hash, origem: 'app', ativo: true })
        .select('id,nome,whatsapp').single()
      if (en) throw en
      cli = novo
    }
    return res.json({ token: tokenCliente(cli), cliente: { id: cli.id, nome: cli.nome, whatsapp: cli.whatsapp } })
  } catch (e) {
    console.error('[publico/registrar]', e.message)
    return res.status(500).json({ erro: 'Erro ao criar conta' })
  }
})

// ============================================================
// POST /publico/login — entra com WhatsApp + senha
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const { whatsapp, senha } = req.body || {}
    if (!whatsapp || !senha) return res.status(400).json({ erro: 'Informe WhatsApp e senha' })
    const tel = String(whatsapp).replace(/\D/g, '')
    if (tel.length < 8) return res.status(400).json({ erro: 'WhatsApp inválido' })

    const { data: achados } = await supabaseAdmin.from('clientes')
      .select('id,nome,whatsapp,senha_hash,ativo').ilike('whatsapp', '%' + tel.slice(-8) + '%').limit(1)
    const cli = achados && achados[0]
    if (!cli || !cli.senha_hash) return res.status(401).json({ erro: 'Conta não encontrada. Crie uma conta.' })
    if (cli.ativo === false) return res.status(401).json({ erro: 'Conta inativa. Fale com a barbearia.' })
    if (!bcrypt.compareSync(String(senha), cli.senha_hash)) return res.status(401).json({ erro: 'WhatsApp ou senha incorretos' })

    return res.json({ token: tokenCliente(cli), cliente: { id: cli.id, nome: cli.nome, whatsapp: cli.whatsapp } })
  } catch (e) {
    console.error('[publico/login]', e.message)
    return res.status(500).json({ erro: 'Erro ao entrar' })
  }
})

// ============================================================
// GET /publico/eu — dados do cliente logado (perfil)
// ============================================================
router.get('/eu', autenticarCliente, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('clientes')
      .select('id,nome,whatsapp,foto_url').eq('id', req.cliente.id).single()
    if (error) throw error
    return res.json(data)
  } catch (e) {
    console.error('[publico/eu]', e.message)
    return res.status(500).json({ erro: 'Erro ao carregar perfil' })
  }
})

// ============================================================
// PUT /publico/eu — atualiza o nome do cliente
// ============================================================
router.put('/eu', autenticarCliente, async (req, res) => {
  try {
    const { nome } = req.body || {}
    if (!nome || !String(nome).trim()) return res.status(400).json({ erro: 'Informe o nome' })
    const { data, error } = await supabaseAdmin.from('clientes')
      .update({ nome: String(nome).trim() }).eq('id', req.cliente.id)
      .select('id,nome,whatsapp,foto_url').single()
    if (error) throw error
    return res.json(data)
  } catch (e) {
    console.error('[publico/eu PUT]', e.message)
    return res.status(500).json({ erro: 'Erro ao salvar' })
  }
})

// ============================================================
// GET /publico/meu-plano — assinatura ativa do cliente + uso do mês
// ============================================================
router.get('/meu-plano', autenticarCliente, async (req, res) => {
  try {
    const { data: assin } = await supabaseAdmin.from('assinaturas')
      .select('*, planos(id,nome,valor_mensal)').eq('cliente_id', req.cliente.id)
      .eq('status', 'ativa').limit(1)
    if (!assin || !assin.length) return res.json({ ativo: false })
    const a = assin[0]
    const plano = a.planos || {}

    // serviços incluídos no plano + limite
    const { data: ps } = await supabaseAdmin.from('plano_servicos')
      .select('servico_id, limite_mes, servicos(nome)').eq('plano_id', plano.id)

    // uso do mês (agendamentos concluídos deste cliente neste mês)
    const agora = new Date()
    const ini = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString()
    const { data: usados } = await supabaseAdmin.from('agendamentos')
      .select('servico_id').eq('cliente_id', req.cliente.id)
      .eq('status', 'concluido').gte('data_hora_ini', ini)
    const cont = {}
    ;(usados || []).forEach(u => { cont[u.servico_id] = (cont[u.servico_id] || 0) + 1 })

    const servicos = (ps || []).map(x => ({
      nome: (x.servicos && x.servicos.nome) || 'Serviço',
      limite_mes: x.limite_mes,
      usado: cont[x.servico_id] || 0,
    }))
    return res.json({ ativo: true, plano: { nome: plano.nome, valor_mensal: plano.valor_mensal }, servicos })
  } catch (e) {
    console.error('[publico/meu-plano]', e.message)
    return res.status(500).json({ erro: 'Erro ao carregar plano' })
  }
})

// ============================================================
//  PUSH NOTIFICATIONS — Fase 1 (base)
//  Rotas: /publico/push/chave, /push/inscrever, /push/remover, /push/teste
//  web-push é carregado com proteção: se ainda não estiver instalado,
//  o app NÃO quebra — as rotas de push só respondem que está indisponível.
// ============================================================
let webpush = null
try {
  webpush = require('web-push')
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:contato@barbearia1989.com.br',
      process.env.VAPID_PUBLIC,
      process.env.VAPID_PRIVATE
    )
    console.log('[push] web-push configurado')
  } else {
    console.warn('[push] VAPID_PUBLIC/PRIVATE não definidos — push desligado')
  }
} catch (e) {
  console.warn('[push] biblioteca web-push ainda não instalada:', e.message)
}

// Envia um push para TODOS os aparelhos ativos de um cliente.
// Reutilizado nas próximas fases (lembretes automáticos e massa).
async function enviarPushParaCliente(cliente_id, payload) {
  if (!webpush || !process.env.VAPID_PUBLIC) return { enviados: 0, falhas: 0 }
  const { data: subs } = await supabaseAdmin
    .from('push_inscricoes').select('*')
    .eq('cliente_id', cliente_id).eq('ativo', true)
  let enviados = 0, falhas = 0
  for (const s of (subs || [])) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      )
      enviados++
      await supabaseAdmin.from('push_inscricoes')
        .update({ ultimo_envio: new Date().toISOString() }).eq('endpoint', s.endpoint)
    } catch (err) {
      falhas++
      // 404/410 = aparelho não aceita mais -> desativa para não tentar de novo
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await supabaseAdmin.from('push_inscricoes')
          .update({ ativo: false }).eq('endpoint', s.endpoint)
      }
    }
  }
  return { enviados, falhas }
}

// Envia o MESMO push para vários clientes de uma vez (rápido: busca as inscrições
// em lote em vez de uma consulta por cliente). Usado no push em massa.
async function enviarPushParaVarios(clienteIds, payload) {
  if (!webpush || !process.env.VAPID_PUBLIC) return { enviados: 0, falhas: 0, aparelhos: 0 }
  if (!clienteIds || !clienteIds.length) return { enviados: 0, falhas: 0, aparelhos: 0 }

  let subs = []
  for (let i = 0; i < clienteIds.length; i += 300) {
    const parte = clienteIds.slice(i, i + 300)
    const { data } = await supabaseAdmin
      .from('push_inscricoes').select('endpoint, p256dh, auth')
      .eq('ativo', true).in('cliente_id', parte)
    if (data) subs = subs.concat(data)
  }

  const payloadStr = JSON.stringify(payload)
  let enviados = 0, falhas = 0
  for (let i = 0; i < subs.length; i += 50) {
    const lote = subs.slice(i, i + 50)
    const rs = await Promise.allSettled(lote.map(s =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payloadStr)
    ))
    rs.forEach((r, idx) => {
      if (r.status === 'fulfilled') { enviados++; return }
      falhas++
      const code = r.reason && r.reason.statusCode
      if (code === 404 || code === 410) {
        supabaseAdmin.from('push_inscricoes').update({ ativo: false }).eq('endpoint', lote[idx].endpoint).then(() => {}, () => {})
      }
    })
  }
  return { enviados, falhas, aparelhos: subs.length }
}

// Chave pública — o app usa pra se inscrever (não é segredo)
router.get('/push/chave', (_req, res) => {
  if (!process.env.VAPID_PUBLIC) return res.status(503).json({ erro: 'Push não configurado' })
  res.json({ publicKey: process.env.VAPID_PUBLIC })
})

// Salva (ou atualiza) a inscrição do aparelho do cliente logado
router.post('/push/inscrever', autenticarCliente, async (req, res) => {
  try {
    const sub = (req.body && req.body.subscription) ? req.body.subscription : req.body
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ erro: 'Inscrição inválida' })
    }
    const { error } = await supabaseAdmin.from('push_inscricoes').upsert({
      cliente_id: req.cliente.id,
      endpoint:   sub.endpoint,
      p256dh:     sub.keys.p256dh,
      auth:       sub.keys.auth,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      ativo:      true,
    }, { onConflict: 'endpoint' })
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    console.error('[push/inscrever]', e.message)
    res.status(500).json({ erro: 'Erro ao salvar inscrição' })
  }
})

// Remove/desativa a inscrição (quando o cliente desliga as notificações)
router.post('/push/remover', autenticarCliente, async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint
    if (endpoint) {
      await supabaseAdmin.from('push_inscricoes')
        .update({ ativo: false }).eq('endpoint', endpoint).eq('cliente_id', req.cliente.id)
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('[push/remover]', e.message)
    res.status(500).json({ erro: 'Erro ao remover' })
  }
})

// Envia um push de TESTE para o próprio cliente (confere se está tudo certo)
router.post('/push/teste', autenticarCliente, async (req, res) => {
  try {
    if (!webpush || !process.env.VAPID_PUBLIC) {
      return res.status(503).json({ erro: 'Push não configurado no servidor' })
    }
    const r = await enviarPushParaCliente(req.cliente.id, {
      titulo: 'Barbearia 1989 ✂️',
      corpo:  'Notificações ativadas! Você vai receber lembretes dos seus horários por aqui.',
      url:    '/'
    })
    if (r.enviados === 0) return res.status(404).json({ erro: 'Nenhum aparelho inscrito ainda. Ative as notificações primeiro.' })
    res.json({ ok: true, enviados: r.enviados, falhas: r.falhas })
  } catch (e) {
    console.error('[push/teste]', e.message)
    res.status(500).json({ erro: 'Erro ao enviar teste' })
  }
})

module.exports = router
module.exports.enviarPushParaCliente = enviarPushParaCliente
module.exports.enviarPushParaVarios = enviarPushParaVarios
