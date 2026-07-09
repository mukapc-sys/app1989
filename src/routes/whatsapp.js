// ============================================================
// routes/whatsapp.js — Webhook Evolution API + Atendimento
// ============================================================
const express           = require('express')
const router            = express.Router()
const { supabaseAdmin } = require('../config/supabase')

// ---- Normaliza número ----
function normalizeNumero(raw) {
  if (!raw) return null
  return raw.replace(/@.*/, '').replace(/\D/g, '')
}

// ---- Busca cliente pelo número (usa função SQL que normaliza dígitos) ----
async function buscarClientePorNumero(numero) {
  try {
    const { data, error } = await supabaseAdmin.rpc('buscar_cliente_por_telefone', { tel: numero })
    if (error) throw error
    return (data && data[0]) || null
  } catch (e) {
    console.error('[wpp/buscarCliente]', e.message)
    return null
  }
}

// ---- Busca ou cria conversa ----
async function getOrCreateConversa(numero, nomeContato) {
  const { data: existente } = await supabaseAdmin
    .from('whatsapp_conversas')
    .select('id, cliente_id, status, atendente, estado_ia, dados_ia, requer_humano')
    .eq('numero', numero)
    .order('criado_em', { ascending: false })
    .limit(1)
    .single()

  if (existente) {
    const upd = { nome_contato: nomeContato, ultima_msg_em: new Date().toISOString() }

    // Se ainda não tem cliente vinculado, tenta vincular agora
    if (!existente.cliente_id) {
      const cli = await buscarClientePorNumero(numero)
      if (cli) {
        upd.cliente_id = cli.id
        existente.cliente_id = cli.id
      }
    }

    await supabaseAdmin.from('whatsapp_conversas').update(upd).eq('id', existente.id)
    return existente
  }

  // Vincula cliente pelo número
  const cli = await buscarClientePorNumero(numero)

  const { data: nova } = await supabaseAdmin.from('whatsapp_conversas')
    .insert({
      numero,
      nome_contato:  nomeContato,
      cliente_id:    cli ? cli.id : null,
      status:        'aberta',
      atendente:     'ia',
      estado_ia:     'inicial',
      dados_ia:      {},
      requer_humano: false,
      ultima_msg_em: new Date().toISOString()
    })
    .select('id, cliente_id, status, atendente, estado_ia, dados_ia, requer_humano')
    .single()

  return nova
}

// ============================================================
// POST /whatsapp/webhook — recebe eventos do Evolution
// ============================================================
router.post('/webhook', async (req, res) => {
  try {
    res.status(200).json({ ok: true })

    const body  = req.body || {}
    const event = body.event || ''
    const data  = body.data  || {}

    if (event !== 'messages.upsert') return
    if (data.key?.fromMe) return
    if (!data.message)    return

    const numero      = normalizeNumero(data.key?.remoteJid)
    const nomeContato = data.pushName || numero
    const msgId       = data.key?.id  || null
    if (!numero) return

    // Extrai conteúdo
    let tipo     = 'texto'
    let conteudo = null
    let midiaUrl = null

    if (data.message.conversation) {
      conteudo = data.message.conversation
    } else if (data.message.extendedTextMessage) {
      conteudo = data.message.extendedTextMessage.text
    } else if (data.message.audioMessage) {
      tipo = 'audio'; conteudo = '[áudio]'
      midiaUrl = data.message.audioMessage.url || null
    } else if (data.message.imageMessage) {
      tipo = 'imagem'
      conteudo = data.message.imageMessage.caption || '[imagem]'
      midiaUrl = data.message.imageMessage.url || null
    } else {
      conteudo = '[mensagem não suportada]'
    }

    const conversa = await getOrCreateConversa(numero, nomeContato)
    if (!conversa) return

    // Salva mensagem recebida
    await supabaseAdmin.from('whatsapp_mensagens')
      .upsert({
        conversa_id:      conversa.id,
        evolution_msg_id: msgId,
        direcao:          'entrada',
        tipo, conteudo,
        midia_url:        midiaUrl,
        remetente:        'cliente'
      }, { onConflict: 'evolution_msg_id', ignoreDuplicates: true })

    // Se IA está atendendo e não precisa de humano → processa com IA
    // (só roda se WHATSAPP_IA_ATIVA=true nas variáveis do Railway)
    const iaAtiva = process.env.WHATSAPP_IA_ATIVA === 'true'
    if (iaAtiva && conversa.atendente === 'ia' && !conversa.requer_humano && conteudo && tipo === 'texto') {
      await processarComIA(conversa, conteudo)
    }

  } catch (e) {
    console.error('[whatsapp/webhook]', e.message)
  }
})

// ============================================================
// IA — processa mensagem e responde
// ============================================================
async function processarComIA(conversa, mensagemCliente) {
  try {
    const GEMINI_KEY = process.env.GEMINI_API_KEY
    if (!GEMINI_KEY) return // IA não configurada ainda

    // Busca histórico da conversa (últimas 10 msgs para contexto)
    const { data: historico } = await supabaseAdmin
      .from('whatsapp_mensagens')
      .select('direcao, conteudo, remetente')
      .eq('conversa_id', conversa.id)
      .order('criado_em', { ascending: false })
      .limit(10)
    const msgs = (historico || []).reverse()

    // Busca contexto do cliente
    let contextoCliente = 'Cliente não identificado no sistema. Se quiser agendar, peça para cadastrar no app.'
    if (conversa.cliente_id) {
      const ctx = await buscarContextoCliente(conversa.cliente_id)
      if (ctx) {
        contextoCliente = `Cliente: ${ctx.nome}`
        if (ctx.ultima_unidade) contextoCliente += ` | Unidade habitual: ${ctx.ultima_unidade}`
        if (ctx.ultimo_barbeiro) contextoCliente += ` | Barbeiro preferido: ${ctx.ultimo_barbeiro}`
        if (ctx.plano_ativo) contextoCliente += ` | Plano ativo: ${ctx.plano_ativo}`
        if (ctx.pontos) contextoCliente += ` | Pontos: ${ctx.pontos}`
      }
    }

    // Busca serviços disponíveis para contexto
    const { data: servicos } = await supabaseAdmin
      .from('servicos')
      .select('nome, valor, duracao_min')
      .eq('ativo', true)
      .eq('disponivel_online', true)
      .order('nome')
    const listaServicos = (servicos || []).map(s => `${s.nome} (R$${Number(s.valor).toFixed(2)}, ${s.duracao_min}min)`).join(', ')

    // Monta histórico formatado
    const historicoFormatado = msgs.map(m =>
      (m.direcao === 'entrada' ? 'Cliente: ' : 'Assistente: ') + m.conteudo
    ).join('\n')

    const dadosIA = conversa.dados_ia || {}

    const prompt = `Você é a assistente virtual da Barbearia 1989, uma barbearia premium em Montenegro/RS com 3 unidades (Timbaúva, Centro e São João).
Seu objetivo é agendar horários de forma simpática, eficiente e profissional.

REGRAS IMPORTANTES:
- Colete: serviço desejado, unidade de preferência, preferência de barbeiro (opcional), data/horário
- Se o cliente não tiver preferência de barbeiro, informe que escolheremos o mais disponível
- Se a conversa não for sobre agendamento, diga que pode ajudar apenas com agendamentos e transfira para atendente humano com a palavra [TRANSFERIR]
- Se não entender após 2 tentativas, transfira com [TRANSFERIR]
- Quando confirmar um agendamento, use [AGENDAMENTO_CONFIRMADO: serviço | unidade | barbeiro | data | hora]
- Seja sempre simpático e use o nome do cliente quando souber
- Responda em português, de forma curta e direta (máx 3 linhas)

CONTEXTO DO CLIENTE:
${contextoCliente}

SERVIÇOS DISPONÍVEIS:
${listaServicos}

DADOS JÁ COLETADOS:
${JSON.stringify(dadosIA)}

HISTÓRICO DA CONVERSA:
${historicoFormatado}

Mensagem atual do cliente: "${mensagemCliente}"

Responda de forma natural e continue o fluxo de agendamento:`

    // Chama Gemini
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 }
        })
      }
    )

    const geminiData = await resp.json()
    const respostaIA = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!respostaIA) return

    // Verifica se precisa transferir para humano
    if (respostaIA.includes('[TRANSFERIR]')) {
      await supabaseAdmin.from('whatsapp_conversas').update({
        requer_humano:    true,
        requer_humano_em: new Date().toISOString(),
        estado_ia:        'escalado'
      }).eq('id', conversa.id)

      const textoEnvio = respostaIA.replace('[TRANSFERIR]', '').trim() ||
        'Um momento! Vou chamar um de nossos atendentes para te ajudar. 😊'
      await enviarMensagemEvolution(conversa.numero, textoEnvio, conversa.id, 'ia')
      return
    }

    // Verifica se tem agendamento confirmado
    const matchAg = respostaIA.match(/\[AGENDAMENTO_CONFIRMADO:\s*([^\]]+)\]/)
    if (matchAg) {
      await supabaseAdmin.from('whatsapp_conversas').update({
        estado_ia: 'agendado'
      }).eq('id', conversa.id)

      const textoEnvio = respostaIA.replace(matchAg[0], '').trim()
      await enviarMensagemEvolution(conversa.numero, textoEnvio, conversa.id, 'ia')
      return
    }

    // Resposta normal
    await enviarMensagemEvolution(conversa.numero, respostaIA, conversa.id, 'ia')

  } catch (e) {
    console.error('[whatsapp/ia]', e.message)
  }
}

// ---- Envia mensagem via Evolution ----
async function enviarMensagemEvolution(numero, texto, conversaId, remetente) {
  const EVOLUTION_URL = process.env.EVOLUTION_API_URL
  const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
  const INSTANCIA     = process.env.EVOLUTION_INSTANCIA || 'barbearia1989'

  const resp = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCIA}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
    body: JSON.stringify({ number: numero, text: texto, options: { delay: 1200 } })
  })

  const result = await resp.json()

  await supabaseAdmin.from('whatsapp_mensagens').insert({
    conversa_id:      conversaId,
    evolution_msg_id: result.key?.id || null,
    direcao:          'saida',
    tipo:             'texto',
    conteudo:         texto,
    remetente
  })

  await supabaseAdmin.from('whatsapp_conversas')
    .update({ ultima_msg_em: new Date().toISOString() })
    .eq('id', conversaId)
}

// ---- Busca contexto completo do cliente ----
async function buscarContextoCliente(clienteId) {
  try {
    const [
      { data: cli },
      { data: ultimoAg },
      { data: plano },
      { data: carteira }
    ] = await Promise.all([
      supabaseAdmin.from('clientes').select('nome, email, user_id, whatsapp').eq('id', clienteId).single(),
      supabaseAdmin.from('agendamentos')
        .select('unidades(nome), colaboradores(nome)')
        .eq('cliente_id', clienteId)
        .eq('status', 'realizado')
        .order('data', { ascending: false })
        .limit(1)
        .single(),
      supabaseAdmin.from('assinaturas')
        .select('planos(nome), status, data_renovacao')
        .eq('cliente_id', clienteId)
        .eq('status', 'ativa')
        .limit(1)
        .single(),
      supabaseAdmin.from('carteira_pontos')
        .select('saldo')
        .eq('cliente_id', clienteId)
        .single()
    ])

    return {
      nome:           cli?.nome,
      email:          cli?.email,
      tem_app:        !!cli?.user_id,
      ultima_unidade: ultimoAg?.unidades?.nome || null,
      ultimo_barbeiro: ultimoAg?.colaboradores?.nome || null,
      plano_ativo:    plano?.planos?.nome || null,
      plano_vence:    plano?.data_renovacao || null,
      pontos:         carteira?.saldo || 0
    }
  } catch (e) {
    return null
  }
}

// ============================================================
// GET /whatsapp/conversas — lista conversas
// ============================================================
router.get('/conversas', async (req, res) => {
  try {
    const { status = 'aberta' } = req.query
    const { data } = await supabaseAdmin
      .from('whatsapp_conversas')
      .select('id, numero, nome_contato, status, atendente, estado_ia, requer_humano, ultima_msg_em, cliente_id, cliente:clientes(id, nome, whatsapp, user_id)')
      .eq('status', status)
      .order('requer_humano', { ascending: false })
      .order('ultima_msg_em', { ascending: false })
      .limit(50)
    res.json(data || [])
  } catch (e) {
    console.error('[whatsapp/conversas]', e.message)
    res.status(500).json({ erro: 'Erro ao buscar conversas' })
  }
})

// ============================================================
// GET /whatsapp/conversas/:id/contexto — contexto do cliente
// ============================================================
router.get('/conversas/:id/contexto', async (req, res) => {
  try {
    const { data: conv } = await supabaseAdmin
      .from('whatsapp_conversas')
      .select('cliente_id, numero, nome_contato, estado_ia, requer_humano')
      .eq('id', req.params.id)
      .single()
    if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada' })

    if (!conv.cliente_id) {
      return res.json({ identificado: false, numero: conv.numero, nome: conv.nome_contato })
    }

    const ctx = await buscarContextoCliente(conv.cliente_id)
    res.json({ identificado: true, ...ctx })
  } catch (e) {
    console.error('[whatsapp/contexto]', e.message)
    res.status(500).json({ erro: e.message })
  }
})

// ============================================================
// GET /whatsapp/conversas/:id/mensagens
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
    res.status(500).json({ erro: 'Erro ao buscar mensagens' })
  }
})

// ============================================================
// POST /whatsapp/conversas/:id/enviar — envia mensagem (humano)
// ============================================================
router.post('/conversas/:id/enviar', async (req, res) => {
  try {
    const { texto, remetente = 'humano' } = req.body || {}
    if (!texto) return res.status(400).json({ erro: 'Informe o texto' })

    const { data: conv } = await supabaseAdmin
      .from('whatsapp_conversas').select('numero').eq('id', req.params.id).single()
    if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada' })

    await enviarMensagemEvolution(conv.numero, texto, req.params.id, remetente)
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
    const { status, atendente, requer_humano } = req.body || {}
    const upd = {}
    if (status !== undefined)        upd.status        = status
    if (atendente !== undefined)     upd.atendente     = atendente
    if (requer_humano !== undefined) upd.requer_humano = requer_humano
    await supabaseAdmin.from('whatsapp_conversas').update(upd).eq('id', req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

// ============================================================
// GET /whatsapp/alertas — conversas que precisam de humano
// (polling rápido da tela do caixa)
// ============================================================
router.get('/alertas', async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('whatsapp_conversas')
      .select('id, nome_contato, numero, requer_humano_em')
      .eq('requer_humano', true)
      .eq('status', 'aberta')
      .order('requer_humano_em', { ascending: false })
    res.json(data || [])
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

module.exports = router
