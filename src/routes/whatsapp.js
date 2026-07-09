// ============================================================
// routes/whatsapp.js — Webhook do Evolution API + conversas
// ============================================================
const express        = require('express')
const router         = express.Router()
const { supabaseAdmin } = require('../config/supabase')

// ---- Normaliza número pra formato 55DDDNÚMERO (só dígitos) ----
function normalizeNumero(raw) {
  if (!raw) return null
  // Remove @s.whatsapp.net e tudo que não for dígito
  return raw.replace(/@.*/, '').replace(/\D/g, '')
}

// ---- Busca ou cria conversa pelo número ----
async function getOrCreateConversa(numero, nomeContato) {
  const { data: existente } = await supabaseAdmin
    .from('whatsapp_conversas')
    .select('id, cliente_id, status, atendente')
    .eq('numero', numero)
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (existente) {
    // Atualiza nome e ultima_msg_em
    await supabaseAdmin.from('whatsapp_conversas')
      .update({ nome_contato: nomeContato, ultima_msg_em: new Date().toISOString() })
      .eq('id', existente.id)
    return existente
  }

  // Tenta vincular a um cliente pelo número
  let clienteId = null
  const digitos = numero.replace(/\D/g, '')
  const sufixo  = digitos.slice(-9) // últimos 9 dígitos
  const { data: cli } = await supabaseAdmin.from('clientes')
    .select('id')
    .ilike('whatsapp', `%${sufixo}`)
    .eq('ativo', true)
    .limit(1)
    .single()
  if (cli) clienteId = cli.id

  const { data: nova } = await supabaseAdmin.from('whatsapp_conversas')
    .insert({
      numero,
      nome_contato:  nomeContato,
      cliente_id:    clienteId,
      status:        'aberta',
      atendente:     'ia',
      ultima_msg_em: new Date().toISOString()
    })
    .select('id, cliente_id, status, atendente')
    .single()

  return nova
}

// ============================================================
// POST /whatsapp/webhook — recebe eventos do Evolution API
// ============================================================
router.post('/webhook', async (req, res) => {
  try {
    res.status(200).json({ ok: true }) // responde rápido pro Evolution

    const body  = req.body || {}
    const event = body.event || ''
    const data  = body.data  || {}

    // Só processa mensagens recebidas (não processa as que a gente envia)
    if (event !== 'messages.upsert') return
    if (data.key?.fromMe) return      // mensagem enviada por nós → ignora
    if (!data.message)    return      // sem conteúdo → ignora

    const numero      = normalizeNumero(data.key?.remoteJid)
    const nomeContato = data.pushName || numero
    const msgId       = data.key?.id  || null

    if (!numero) return

    // Extrai conteúdo da mensagem (texto, áudio, imagem)
    let tipo    = 'texto'
    let conteudo = null
    let midiaUrl = null

    if (data.message.conversation) {
      conteudo = data.message.conversation
    } else if (data.message.extendedTextMessage) {
      conteudo = data.message.extendedTextMessage.text
    } else if (data.message.audioMessage) {
      tipo     = 'audio'
      midiaUrl = data.message.audioMessage.url || null
      conteudo = '[áudio]'
    } else if (data.message.imageMessage) {
      tipo     = 'imagem'
      midiaUrl = data.message.imageMessage.url || null
      conteudo = data.message.imageMessage.caption || '[imagem]'
    } else if (data.message.documentMessage) {
      tipo     = 'documento'
      conteudo = data.message.documentMessage.fileName || '[documento]'
    } else {
      conteudo = '[mensagem não suportada]'
    }

    // Busca ou cria a conversa
    const conversa = await getOrCreateConversa(numero, nomeContato)
    if (!conversa) return

    // Salva a mensagem (ignora se já existe pelo evolution_msg_id)
    await supabaseAdmin.from('whatsapp_mensagens')
      .upsert({
        conversa_id:     conversa.id,
        evolution_msg_id: msgId,
        direcao:         'entrada',
        tipo,
        conteudo,
        midia_url:       midiaUrl,
        remetente:       'cliente'
      }, { onConflict: 'evolution_msg_id', ignoreDuplicates: true })

  } catch (e) {
    console.error('[whatsapp/webhook]', e.message)
  }
})

// ============================================================
// GET /whatsapp/conversas — lista conversas abertas (caixa)
// ============================================================
router.get('/conversas', async (req, res) => {
  try {
    const { status = 'aberta' } = req.query
    const { data } = await supabaseAdmin
      .from('whatsapp_conversas')
      .select(`
        id, numero, nome_contato, status, atendente, ultima_msg_em,
        cliente:clientes(id, nome, whatsapp)
      `)
      .eq('status', status)
      .order('ultima_msg_em', { ascending: false })
      .limit(50)
    res.json(data || [])
  } catch (e) {
    console.error('[whatsapp/conversas]', e.message)
    res.status(500).json({ erro: 'Erro ao buscar conversas' })
  }
})

// ============================================================
// GET /whatsapp/conversas/:id/mensagens — mensagens de uma conversa
// ============================================================
router.get('/conversas/:id/mensagens', async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('whatsapp_mensagens')
      .select('id, direcao, tipo, conteudo, midia_url, remetente, criado_em')
      .eq('conversa_id', req.params.id)
      .order('criado_em', { ascending: true })
      .limit(100)
    res.json(data || [])
  } catch (e) {
    console.error('[whatsapp/mensagens]', e.message)
    res.status(500).json({ erro: 'Erro ao buscar mensagens' })
  }
})

// ============================================================
// POST /whatsapp/conversas/:id/enviar — envia mensagem de texto
// ============================================================
router.post('/conversas/:id/enviar', async (req, res) => {
  try {
    const { texto, remetente = 'humano' } = req.body || {}
    if (!texto) return res.status(400).json({ erro: 'Informe o texto' })

    // Busca o número da conversa
    const { data: conv } = await supabaseAdmin
      .from('whatsapp_conversas')
      .select('numero')
      .eq('id', req.params.id)
      .single()
    if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada' })

    // Envia via Evolution API
    const EVOLUTION_URL = process.env.EVOLUTION_API_URL
    const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
    const INSTANCIA     = process.env.EVOLUTION_INSTANCIA || 'barbearia1989'

    const resp = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCIA}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':       EVOLUTION_KEY
      },
      body: JSON.stringify({
        number:  conv.numero,
        text:    texto,
        options: { delay: 1000 }
      })
    })

    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(`Evolution: ${err}`)
    }

    const result = await resp.json()

    // Salva a mensagem enviada
    await supabaseAdmin.from('whatsapp_mensagens').insert({
      conversa_id:      req.params.id,
      evolution_msg_id: result.key?.id || null,
      direcao:          'saida',
      tipo:             'texto',
      conteudo:         texto,
      remetente
    })

    // Atualiza ultima_msg_em e atendente
    await supabaseAdmin.from('whatsapp_conversas')
      .update({ ultima_msg_em: new Date().toISOString(), atendente: remetente })
      .eq('id', req.params.id)

    res.json({ ok: true })
  } catch (e) {
    console.error('[whatsapp/enviar]', e.message)
    res.status(500).json({ erro: e.message })
  }
})

// ============================================================
// PATCH /whatsapp/conversas/:id — atualiza status/atendente
// ============================================================
router.patch('/conversas/:id', async (req, res) => {
  try {
    const { status, atendente } = req.body || {}
    const upd = {}
    if (status)    upd.status    = status
    if (atendente) upd.atendente = atendente
    await supabaseAdmin.from('whatsapp_conversas').update(upd).eq('id', req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

module.exports = router
