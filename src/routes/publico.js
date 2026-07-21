// ============================================================
//  ROTAS PÚBLICAS (sem login) — usadas pelo app do cliente
//  (barbearia1989.com.br)
//  Não exigem token. Mantêm validação para evitar abuso básico.
// ============================================================
const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { supabaseAdmin } = require('../config/supabase')
const { enviarPushParaColaborador } = require('./push-pro')
// ============================================================
// Busca de cliente por telefone — normalização robusta.
// Mesmo critério do sync do AppBarber (tira DDI 55, compara 11 dígitos).
// Evita duplicar cadastro e casa com o cliente importado do AppBarber.
// ============================================================
function normalizarTel(s) {
  if (!s) return null
  let t = String(s).replace(/\D/g, '')          // só dígitos
  if (t.length >= 12 && t.startsWith('55')) t = t.slice(2) // tira DDI 55
  return t || null
}
// Retorna o cliente que casa pelo telefone, ou null. Tenta 11 dígitos e cai pra 10.
async function acharClientePorTel(whatsapp, campos) {
  const tel = normalizarTel(whatsapp)
  if (!tel || tel.length < 10) return null
  const sel = campos || 'id,nome,whatsapp,senha_hash,ativo'
  // 1) tenta pelos últimos 11 dígitos (celular com 9)
  if (tel.length >= 11) {
    const { data } = await supabaseAdmin.from('clientes').select(sel).ilike('whatsapp', '%' + tel.slice(-11) + '%').limit(1)
    if (data && data.length) return data[0]
  }
  // 2) cai pros últimos 10 (fixo ou celular antigo sem 9)
  const { data: d2 } = await supabaseAdmin.from('clientes').select(sel).ilike('whatsapp', '%' + tel.slice(-10) + '%').limit(1)
  if (d2 && d2.length) return d2[0]
  return null
}
// ============================================================
// "Cliente voltou" — reativa o cadastro.
//
// IMPORTANTE: `ativo` é uma ETIQUETA DE NEGÓCIO (cliente ausente da barbearia),
// NÃO uma tranca de acesso. Usá-la para barrar login prendia ~30 mil clientes
// importados do AppBarber do lado de fora: não entravam ("conta inativa") e não
// conseguiam se cadastrar ("WhatsApp já cadastrado"). Beco sem saída.
// Se o cliente entrou ou agendou, ele VOLTOU -> reativa.
// ============================================================
async function reativarCliente(cliente_id) {
  try {
    await supabaseAdmin.from('clientes').update({ ativo: true }).eq('id', cliente_id)
  } catch (e) { /* não bloqueia o fluxo do cliente por causa disso */ }
}
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
// ============================================================
// Status que OCUPAM o horário de um barbeiro.
//
// 'concluido' PRECISA estar aqui. Sem ele, um cliente atendido mais cedo
// LIBERAVA o próprio horário: às 16h o barbeiro finalizava o atendimento das
// 17h, e o app passava a oferecer as 17h para outro cliente — em cima do
// mesmo horário. (Bug real, relatado em 13/07/2026.)
// ============================================================
const STATUS_OCUPA_HORARIO = ['agendado', 'confirmado', 'andamento', 'bloqueado', 'concluido']
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
    // Checa se notificações estão ativas na tabela de configurações
    const { data: cfg } = await supabaseAdmin
      .from('configuracoes')
      .select('valor')
      .eq('chave', 'whatsapp_notificacoes')
      .single()
    if (!cfg || cfg.valor !== 'true') {
      console.log('[wpp] Notificações WhatsApp desativadas — mensagem não enviada')
      return false
    }
    const url  = process.env.EVOLUTION_API_URL
    const key  = process.env.EVOLUTION_API_KEY
    const inst = process.env.EVOLUTION_INSTANCIA || process.env.EVOLUTION_INSTANCE || 'barbearia1989'
    if (!url || !key) {
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
    // Todos os serviços ativos e disponíveis online
    const { data: todos, error } = await supabaseAdmin.from('servicos')
      .select('id,nome,duracao_min,valor,disponivel_online,ativo,restrito_barbeiro')
      .eq('ativo', true).eq('disponivel_online', true).order('nome')
    if (error) throw error
    // Vínculos do barbeiro escolhido (colaborador_servicos)
    let vinc = []
    if (colaborador_id) {
      const { data: v } = await supabaseAdmin
        .from('colaborador_servicos').select('servico_id').eq('colaborador_id', colaborador_id)
      vinc = (v || []).map(x => x.servico_id)
    }
    const vincSet = new Set(vinc)
    const lista     = todos || []
    const gerais    = lista.filter(s => !s.restrito_barbeiro)
    const restritos = lista.filter(s => s.restrito_barbeiro)
    const idsGerais = new Set(gerais.map(s => s.id))
    // Só aplica a "config de serviços do barbeiro" se ele tiver vínculo com algum serviço GERAL
    const temConfigGeral = colaborador_id && vinc.some(id => idsGerais.has(id))
    const gOut = temConfigGeral ? gerais.filter(s => vincSet.has(s.id)) : gerais
    // Serviço restrito só aparece se o barbeiro escolhido estiver vinculado a ele
    const rOut = colaborador_id ? restritos.filter(s => vincSet.has(s.id)) : []
    let result = gOut.concat(rOut).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
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
// slotsDisponiveis — DISPONIBILIDADE CANÔNICA de um colaborador num dia.
// Fonte ÚNICA de verdade: agendamentos + bloqueios + importados (AppBarber) +
// feriados + funcionamento + 15 min. Usada pela rota /horarios E pelo bot do
// WhatsApp (via require), pra os dois nunca divergirem.
// Retorna [{ hora:'HH:MM', disponivel:bool, data_hora:ISO }].
// ============================================================
async function slotsDisponiveis(colaborador_id, data, duracao = 30) {
  const ini = new Date(data + 'T00:00:00-03:00').toISOString()
  const fim = new Date(data + 'T23:59:59-03:00').toISOString()
  const [{ data: ocupados }, { data: bloqueios }, { data: importados }, { data: feriados }] = await Promise.all([
    supabaseAdmin.from('agendamentos')
      .select('data_hora_ini, data_hora_fim')
      .eq('colaborador_id', colaborador_id)
      .in('status', STATUS_OCUPA_HORARIO)
      .gte('data_hora_ini', ini).lte('data_hora_ini', fim),
    supabaseAdmin.from('bloqueios')
      .select('data_ini, data_fim')
      .eq('colaborador_id', colaborador_id)
      .gte('data_ini', ini).lte('data_ini', fim),
    supabaseAdmin.from('agenda_appbarber')
      .select('inicio, fim')
      .eq('colaborador_id', colaborador_id)
      .eq('finalizado', false)
      .gte('inicio', ini).lte('inicio', fim),
    supabaseAdmin.from('feriados').select('*').eq('data', data),
  ])
  const fer = (feriados || [])[0]
  let hf
  if (fer) {
    if (fer.fechado) hf = null
    else if (fer.hora_abre && fer.hora_fecha) hf = { abre: hmToMin(fer.hora_abre), fecha: hmToMin(fer.hora_fecha) }
    else hf = { abre: 9 * 60, fecha: 18 * 60 }
  } else {
    hf = horarioFuncionamento(data, false)
  }
  const inicio = hf ? hf.abre : 0
  const fimDia = hf ? hf.fecha : 0
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
    const passou = slotIni < new Date(agora.getTime() + 15 * 60 * 1000)  // 15 min de antecedência mínima
    slots.push({ hora: `${hh}:${mm}`, disponivel: !ocupado && !bloqueado && !importadoOcupa && !passou, data_hora: slotIni.toISOString() })
  }
  return slots
}

// ============================================================
// GET /publico/horarios?colaborador_id=&data=&duracao= — slots livres
// ============================================================
router.get('/horarios', async (req, res) => {
  try {
    const { colaborador_id, data, duracao = 30 } = req.query
    if (!colaborador_id || !data) {
      return res.status(400).json({ erro: 'colaborador_id e data são obrigatórios' })
    }
    const slots = await slotsDisponiveis(colaborador_id, data, duracao)
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
    // Se o cliente está LOGADO, o token é a fonte da verdade do cliente_id.
    // (evita agendamento cair em cadastro duplicado e sumir do histórico)
    let clienteIdToken = null
    try {
      const h = req.headers.authorization || ''
      const t = h.replace('Bearer ', '').trim()
      if (t) {
        const d = jwt.verify(t, process.env.JWT_SECRET)
        if (d.tipo === 'cliente') clienteIdToken = d.id
      }
    } catch (_) { /* token inválido -> segue por whatsapp */ }
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
    // 'concluido' incluído: atendimento já finalizado continua ocupando o horário dele.
    const [{ data: conflito }, { data: confImport }] = await Promise.all([
      supabaseAdmin.from('agendamentos')
        .select('id').eq('colaborador_id', colaborador_id)
        .in('status', STATUS_OCUPA_HORARIO)
        .lt('data_hora_ini', fim.toISOString()).gt('data_hora_fim', ini.toISOString()),
      supabaseAdmin.from('agenda_appbarber')
        .select('id').eq('colaborador_id', colaborador_id)
        .eq('finalizado', false)
        .lt('inicio', fim.toISOString()).gt('fim', ini.toISOString()),
    ])
    if ((conflito && conflito.length) || (confImport && confImport.length)) {
      return res.status(409).json({ erro: 'Esse horário acabou de ser ocupado. Escolha outro, por favor.' })
    }
    // cliente: token (logado) tem prioridade; senão acha por WhatsApp; senão cria
    const tel = String(whatsapp).replace(/\D/g, '')
    let cliente_id = clienteIdToken || null
    if (!cliente_id && tel.length >= 8) {
      const achado = await acharClientePorTel(whatsapp, 'id')
      if (achado) cliente_id = achado.id
    }
    if (!cliente_id) {
      const { data: novo, error: ec } = await supabaseAdmin.from('clientes')
        .insert({ nome: String(nome).trim(), whatsapp: normalizarTel(whatsapp) || tel, origem: 'online', unidade_pref: col.unidade_id, ativo: true })
        .select('id').single()
      if (ec) throw ec
      cliente_id = novo.id
    } else {
      // Cliente marcou horário = ele VOLTOU. Tira a etiqueta de "ausente".
      reativarCliente(cliente_id)
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
    // push pro BARBEIRO: cliente marcou um horário pra HOJE (fuso SP)
    try {
      const hojeSP = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
      if (dataBR === hojeSP) {
        const horaBR = String(_hh).padStart(2, '0') + ':' + _p.minute
        enviarPushParaColaborador(colaborador_id, {
          titulo: '📅 Novo agendamento hoje',
          corpo:  horaBR + ' — ' + (primeiro || 'Cliente') + (sv.nome ? ' · ' + sv.nome : ''),
          url:    '/app1989-dashboard',
          tag:    'ag-' + ag.id
        }).catch(() => {})
      }
    } catch (e) { console.error('[push agendamento cliente]', e.message) }
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
      const cli = await acharClientePorTel(req.query.whatsapp, 'id')
      if (!cli) return res.json([])
      cliente_id = cli.id
    }
    // Busca os agendamentos SEM join embutido (evita erro de relação no Supabase).
    const { data: ags, error } = await supabaseAdmin.from('agendamentos')
      .select('id,data_hora_ini,data_hora_fim,status,valor,servico_id,colaborador_id,unidade_id')
      .eq('cliente_id', cliente_id)
      .order('data_hora_ini', { ascending: false })
      .limit(30)
    if (error) throw error
    const lista = ags || []
    if (!lista.length) return res.json([])
    // Preenche nomes com buscas separadas (mesmo padrão do resto do sistema).
    const ids = (arr, campo) => [...new Set(arr.map(x => x[campo]).filter(Boolean))]
    const [svcs, cols, unis] = await Promise.all([
      supabaseAdmin.from('servicos').select('id,nome').in('id', ids(lista, 'servico_id')),
      supabaseAdmin.from('colaboradores').select('id,nome').in('id', ids(lista, 'colaborador_id')),
      supabaseAdmin.from('unidades').select('id,nome').in('id', ids(lista, 'unidade_id')),
    ])
    const mapa = (r) => Object.fromEntries(((r && r.data) || []).map(x => [x.id, x.nome]))
    const mSvc = mapa(svcs), mCol = mapa(cols), mUni = mapa(unis)
    const out = lista.map(a => ({
      id: a.id,
      data_hora_ini: a.data_hora_ini,
      data_hora_fim: a.data_hora_fim,
      status: a.status,
      valor: a.valor,
      servicos: { nome: mSvc[a.servico_id] || 'Serviço' },
      colaboradores: { nome: mCol[a.colaborador_id] || '' },
      unidades: { nome: mUni[a.unidade_id] || '' },
    }))
    return res.json(out)
  } catch (e) {
    console.error('[publico/meus-agendamentos]', e.message)
    return res.status(500).json({ erro: 'Erro ao buscar agendamentos' })
  }
})
// ============================================================
// GET /publico/meus-pontos — saldo de cashback do cliente logado
// ============================================================
router.get('/meus-pontos', async (req, res) => {
  try {
    let cliente_id = null
    const h = req.headers.authorization || ''
    const t = h.replace('Bearer ', '').trim()
    if (t) {
      try {
        const d = jwt.verify(t, process.env.JWT_SECRET)
        if (d.tipo === 'cliente') cliente_id = d.id
      } catch (_) {}
    }
    if (!cliente_id) {
      const cli = await acharClientePorTel(req.query.whatsapp, 'id')
      if (!cli) return res.json({ saldo: 0, total_acumulado: 0 })
      cliente_id = cli.id
    }
    const { data } = await supabaseAdmin.from('carteira_pontos')
      .select('saldo,total_acumulado,expira_em').eq('cliente_id', cliente_id).maybeSingle()
    return res.json({
      saldo: (data && data.saldo) ? data.saldo : 0,
      total_acumulado: (data && data.total_acumulado) ? data.total_acumulado : 0,
      expira_em: (data && data.expira_em) ? data.expira_em : null
    })
  } catch (e) {
    console.error('[publico/meus-pontos]', e.message)
    return res.json({ saldo: 0, total_acumulado: 0, expira_em: null })
  }
})
// ============================================================
// POST /publico/cancelar-agendamento — cliente cancela o próprio horário
// Regra: só até 15 minutos ANTES do horário marcado.
// ============================================================
router.post('/cancelar-agendamento', async (req, res) => {
  try {
    const { agendamento_id } = req.body || {}
    if (!agendamento_id) return res.status(400).json({ erro: 'Agendamento não informado' })
    // identifica o cliente: token (logado) ou whatsapp
    let cliente_id = null
    const h = req.headers.authorization || ''
    const t = h.replace('Bearer ', '').trim()
    if (t) {
      try {
        const d = jwt.verify(t, process.env.JWT_SECRET)
        if (d.tipo === 'cliente') cliente_id = d.id
      } catch (_) {}
    }
    if (!cliente_id) {
      const cli = await acharClientePorTel(req.body.whatsapp, 'id')
      if (!cli) return res.status(401).json({ erro: 'Não foi possível identificar você. Faça login.' })
      cliente_id = cli.id
    }
    // busca o agendamento e confere que é DESTE cliente
    const { data: ag } = await supabaseAdmin.from('agendamentos')
      .select('id,cliente_id,data_hora_ini,status,canal_origem')
      .eq('id', agendamento_id).single()
    if (!ag) return res.status(404).json({ erro: 'Agendamento não encontrado' })
    if (ag.cliente_id !== cliente_id) return res.status(403).json({ erro: 'Esse agendamento não é seu.' })
    // já cancelado/concluído?
    if (['cancelado', 'concluido', 'nao_compareceu'].includes(ag.status)) {
      return res.status(400).json({ erro: 'Esse agendamento não pode mais ser cancelado.' })
    }
    // REGRA DOS 15 MINUTOS
    const agora = new Date()
    const inicio = new Date(ag.data_hora_ini)
    const limite = new Date(inicio.getTime() - 15 * 60 * 1000) // 15 min antes
    if (agora > limite) {
      return res.status(400).json({ erro: 'O prazo para cancelar (até 15 minutos antes) já passou. Fale com a barbearia.' })
    }
    // cancela
    const { error: eu } = await supabaseAdmin.from('agendamentos')
      .update({ status: 'cancelado' }).eq('id', agendamento_id)
    if (eu) throw eu
    return res.json({ ok: true })
  } catch (e) {
    console.error('[publico/cancelar-agendamento]', e.message)
    return res.status(500).json({ erro: 'Erro ao cancelar' })
  }
})
// ============================================================
// POST /publico/registrar — cria conta do cliente (nome, whatsapp, senha)
// ============================================================
router.post('/registrar', async (req, res) => {
  try {
    const { nome, whatsapp, senha } = req.body || {}
    const email = (req.body && req.body.email ? String(req.body.email).trim().toLowerCase() : '')
    if (!nome || !whatsapp || !senha) return res.status(400).json({ erro: 'Preencha nome, WhatsApp e senha' })
    if (String(senha).length < 4) return res.status(400).json({ erro: 'A senha precisa de pelo menos 4 caracteres' })
    const tel = String(whatsapp).replace(/\D/g, '')
    if (tel.length < 10) return res.status(400).json({ erro: 'WhatsApp inválido (use DDD + número)' })
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ erro: 'Digite um e-mail válido' })
    const hash = bcrypt.hashSync(String(senha), 10)
    // O e-mail já pertence a OUTRO cadastro? (respeita a unicidade do banco)
    // Se sim, não gravamos no campo email (guardamos em emails_extras) pra não quebrar.
    let emailLivre = true
    try {
      const { data: donoEmail } = await supabaseAdmin.from('clientes')
        .select('id').ilike('email', email).limit(1)
      if (donoEmail && donoEmail.length) emailLivre = false
    } catch (_) {}
    // já existe um cliente com esse WhatsApp? (normalizado — casa com importados do AppBarber)
    const cliAchado = await acharClientePorTel(whatsapp, 'id,nome,whatsapp,senha_hash,email,emails_extras')
    let cli
    if (cliAchado) {
      cli = cliAchado
      if (cli.senha_hash) return res.status(409).json({ erro: 'Já existe uma conta com esse WhatsApp. Faça login.' })
      // Cliente já existia (importado do AppBarber ou criado ao agendar) e ainda não tinha
      // senha -> ele ASSUME o cadastro: mantém histórico, pontos e agendamentos.
      // ativo: true -> se estava marcado como ausente, voltou.
      const upd = { nome: String(nome).trim(), senha_hash: hash, ativo: true }
      // e-mail: se o campo principal está vazio e o e-mail está livre, grava nele;
      // senão, guarda em emails_extras (sem duplicar) pra não perder o dado.
      if (emailLivre && (!cli.email || cli.email === '')) {
        upd.email = email
      } else if (email && (!cli.email || cli.email.toLowerCase() !== email)) {
        const extras = Array.isArray(cli.emails_extras) ? cli.emails_extras : []
        if (extras.indexOf(email) === -1) upd.emails_extras = extras.concat([email])
      }
      const { data: up, error: eu } = await supabaseAdmin.from('clientes')
        .update(upd).eq('id', cli.id)
        .select('id,nome,whatsapp').single()
      if (eu) throw eu
      cli = up
    } else {
      const insert = { nome: String(nome).trim(), whatsapp: normalizarTel(whatsapp) || tel, senha_hash: hash, origem: 'app', ativo: true }
      if (emailLivre) insert.email = email
      else insert.emails_extras = [email]   // e-mail já usado por outro -> guarda como extra
      const { data: novo, error: en } = await supabaseAdmin.from('clientes')
        .insert(insert)
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
    // aceita 'identificador' (novo: e-mail ou whats) ou 'whatsapp' (compatibilidade)
    const bruto = String((req.body && (req.body.identificador || req.body.whatsapp || req.body.email)) || '').trim()
    const senha = req.body && req.body.senha
    if (!bruto || !senha) return res.status(400).json({ erro: 'Informe e-mail ou WhatsApp e a senha' })
    const ehEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bruto)
    let cli = null
    if (ehEmail) {
      const email = bruto.toLowerCase()
      // busca pelo e-mail principal OU nos e-mails extras
      const { data: porEmail } = await supabaseAdmin.from('clientes')
        .select('id,nome,whatsapp,senha_hash,ativo')
        .or(`email.ilike.${email},emails_extras.cs.{${email}}`)
        .limit(1)
      cli = (porEmail && porEmail[0]) || null
    } else {
      const tel = bruto.replace(/\D/g, '')
      if (tel.length < 8) return res.status(400).json({ erro: 'WhatsApp inválido' })
      cli = await acharClientePorTel(bruto, 'id,nome,whatsapp,senha_hash,ativo')
    }
    if (!cli || !cli.senha_hash) return res.status(401).json({ erro: 'Conta não encontrada. Crie uma conta.' })
    if (!bcrypt.compareSync(String(senha), cli.senha_hash)) return res.status(401).json({ erro: 'E-mail/WhatsApp ou senha incorretos' })
    // ⚠️ NÃO barrar por `ativo`.
    // `ativo = false` é só a ETIQUETA de "cliente ausente da barbearia" — controle interno.
    // Antes, esta rota devolvia "Conta inativa. Fale com a barbearia." e o cliente ficava
    // preso: não entrava, e ao tentar se cadastrar batia em "WhatsApp já cadastrado".
    // Isso trancava ~30 mil clientes importados do AppBarber do lado de fora — justamente
    // os ausentes que a barbearia quer de volta.
    // Entrou com a senha certa = é ele, e voltou. Reativa.
    if (cli.ativo === false) reativarCliente(cli.id)
    return res.json({ token: tokenCliente(cli), cliente: { id: cli.id, nome: cli.nome, whatsapp: cli.whatsapp } })
  } catch (e) {
    console.error('[publico/login]', e.message)
    return res.status(500).json({ erro: 'Erro ao entrar' })
  }
})
// ============================================================
// POST /publico/senha/esqueci — gera um código e envia pelo WhatsApp
// ============================================================
router.post('/senha/esqueci', async (req, res) => {
  try {
    const { whatsapp } = req.body || {}
    const tel = String(whatsapp || '').replace(/\D/g, '')
    if (tel.length < 10) return res.status(400).json({ erro: 'Informe o WhatsApp com DDD' })
    const cli = await acharClientePorTel(whatsapp, 'id,nome,whatsapp,senha_hash')
    // Só envia se existir uma conta com senha. Mesmo assim, responde sempre "ok"
    // para não revelar se o número tem conta ou não.
    if (cli && cli.senha_hash) {
      const codigo = String(Math.floor(100000 + Math.random() * 900000)) // 6 dígitos
      const expira = new Date(Date.now() + 10 * 60 * 1000).toISOString()  // 10 min
      await supabaseAdmin.from('clientes')
        .update({ reset_codigo: codigo, reset_expira: expira }).eq('id', cli.id)
      const numero = '55' + String(cli.whatsapp || tel).replace(/\D/g, '')
      await supabaseAdmin.from('notificacoes_whatsapp').insert({
        destinatario: numero,
        mensagem: `Barbearia 1989: seu código para redefinir a senha é ${codigo}. Vale por 10 minutos. Se não foi você, ignore.`,
        tipo: 'reset_senha',
        status: 'pendente'
      })
    }
    return res.json({ ok: true })
  } catch (e) {
    console.error('[senha/esqueci]', e.message)
    return res.status(500).json({ erro: 'Erro ao enviar o código' })
  }
})
// ============================================================
// POST /publico/senha/redefinir — confere o código e troca a senha
// ============================================================
router.post('/senha/redefinir', async (req, res) => {
  try {
    const { whatsapp, codigo, senha } = req.body || {}
    const tel = String(whatsapp || '').replace(/\D/g, '')
    const cod = String(codigo || '').replace(/\D/g, '')
    if (tel.length < 10 || !cod) return res.status(400).json({ erro: 'Informe o WhatsApp e o código' })
    if (String(senha || '').length < 4) return res.status(400).json({ erro: 'A nova senha precisa de pelo menos 4 caracteres' })
    const cli = await acharClientePorTel(whatsapp, 'id,nome,whatsapp,reset_codigo,reset_expira')
    if (!cli || !cli.reset_codigo) return res.status(400).json({ erro: 'Código inválido. Peça um novo.' })
    if (cli.reset_expira && new Date(cli.reset_expira).getTime() < Date.now()) {
      return res.status(400).json({ erro: 'Código expirado. Peça um novo.' })
    }
    if (String(cli.reset_codigo) !== cod) return res.status(400).json({ erro: 'Código incorreto.' })
    const hash = bcrypt.hashSync(String(senha), 10)
    // redefiniu a senha e vai entrar -> também conta como "voltou"
    const { data: up, error: eu } = await supabaseAdmin.from('clientes')
      .update({ senha_hash: hash, reset_codigo: null, reset_expira: null, ativo: true }).eq('id', cli.id)
      .select('id,nome,whatsapp').single()
    if (eu) throw eu
    return res.json({ token: tokenCliente(up), cliente: { id: up.id, nome: up.nome, whatsapp: up.whatsapp } })
  } catch (e) {
    console.error('[senha/redefinir]', e.message)
    return res.status(500).json({ erro: 'Erro ao redefinir a senha' })
  }
})
// ============================================================
// POST /publico/senha/redefinir-direto — reset SEM código (rápido/prático)
//   Identidade leve: WhatsApp + primeiro nome (quando o cadastro tem nome).
//   Não depende do WhatsApp/e-mail sair. Segurança baixa, por decisão do negócio.
//   Para desligar o check de nome (reset só com WhatsApp), remova o bloco marcado.
// ============================================================
router.post('/senha/redefinir-direto', async (req, res) => {
  try {
    const { whatsapp, nome, senha } = req.body || {}
    const tel = String(whatsapp || '').replace(/\D/g, '')
    if (tel.length < 10) return res.status(400).json({ erro: 'Informe o WhatsApp com DDD' })
    if (String(senha || '').length < 4) return res.status(400).json({ erro: 'A nova senha precisa de pelo menos 4 caracteres' })
    const cli = await acharClientePorTel(whatsapp, 'id,nome,whatsapp,senha_hash')
    if (!cli) return res.status(404).json({ erro: 'Não encontramos uma conta com esse WhatsApp.' })
    // --- check de nome (leve). Remova este bloco para reset só com WhatsApp. ---
    const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const primeiro = (s) => norm(s).split(/\s+/)[0] || ''
    if (norm(cli.nome) && primeiro(nome) !== primeiro(cli.nome)) {
      return res.status(400).json({ erro: 'Nome não confere com o cadastro deste WhatsApp.' })
    }
    // --- fim do check de nome ---
    const hash = bcrypt.hashSync(String(senha), 10)
    const { data: up, error: eu } = await supabaseAdmin.from('clientes')
      .update({ senha_hash: hash, reset_codigo: null, reset_expira: null, ativo: true }).eq('id', cli.id)
      .select('id,nome,whatsapp').single()
    if (eu) throw eu
    return res.json({ token: tokenCliente(up), cliente: { id: up.id, nome: up.nome, whatsapp: up.whatsapp } })
  } catch (e) {
    console.error('[senha/redefinir-direto]', e.message)
    return res.status(500).json({ erro: 'Erro ao redefinir a senha' })
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
      .select('*, planos(id,nome,valor_mensal), colaboradores!vendedor_id(id,nome,unidade_id,unidades(id,nome))')
      .eq('cliente_id', req.cliente.id)
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
    // FICHAS DE BAR: disponíveis (acumulam, expiram em 90 dias) + validade do próximo lote
    let fichas_disponiveis = 0
    try {
      const { data: fd } = await supabaseAdmin.rpc('fichas_disponiveis_cliente', { p_cliente: req.cliente.id })
      fichas_disponiveis = parseInt(fd) || 0
    } catch (_) { fichas_disponiveis = 0 }
    // próxima validade: lote não expirado, ainda com saldo, que expira primeiro
    let fichas_validade = null
    try {
      const agoraISO = new Date().toISOString()
      const { data: lotes } = await supabaseAdmin.from('fichas_plano')
        .select('quantidade,usadas,expira_em')
        .eq('cliente_id', req.cliente.id)
        .gt('expira_em', agoraISO)
        .order('expira_em', { ascending: true })
      const loteComSaldo = (lotes || []).find(l => ((l.quantidade || 0) - (l.usadas || 0)) > 0)
      if (loteComSaldo) fichas_validade = loteComSaldo.expira_em
    } catch (_) {}
    const barb = a.colaboradores || null
    const barbeiro = barb ? { id: barb.id, nome: barb.nome } : null
    const unidade = (barb && barb.unidades) ? { id: barb.unidades.id, nome: barb.unidades.nome } : null
    return res.json({
      ativo: true,
      plano: { id: plano.id, nome: plano.nome, valor_mensal: plano.valor_mensal },
      data_renovacao: a.data_renovacao || null,   // vencimento do plano
      servicos, barbeiro, unidade,
      fichas_disponiveis,
      fichas_validade
    })
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
// Envia o MESMO push para TODOS os aparelhos com notificação ativa
// (não depende da lista de clientes nem de nenhum corte). Usado no "Todos".
async function enviarPushParaTodos(payload) {
  if (!webpush || !process.env.VAPID_PUBLIC) return { enviados: 0, falhas: 0, aparelhos: 0 }
  let subs = [], from = 0
  const pag = 1000
  while (true) {
    const { data } = await supabaseAdmin
      .from('push_inscricoes').select('endpoint, p256dh, auth')
      .eq('ativo', true).range(from, from + pag - 1)
    if (!data || !data.length) break
    subs = subs.concat(data)
    if (data.length < pag) break
    from += pag
    if (from > 100000) break
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
module.exports.slotsDisponiveis = slotsDisponiveis
module.exports.enviarPushParaCliente = enviarPushParaCliente
module.exports.enviarPushParaVarios = enviarPushParaVarios
module.exports.enviarPushParaTodos = enviarPushParaTodos
