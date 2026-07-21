// ============================================================
// routes/whatsapp.js — Atendimento WhatsApp com IA roteirizada
// A IA só extrai intenções. Todas as respostas são pré-configuradas.
// ============================================================
const express           = require('express')
const router            = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { slotsDisponiveis } = require('./publico')   // fonte ÚNICA de horários livres (mesma do app)
const bcrypt            = require('bcryptjs')
const jwt               = require('jsonwebtoken')
// ============================================================
// Serviços da barbearia
// ============================================================
async function carregarServicos() {
  const { data } = await supabaseAdmin.from('servicos')
    .select('id, nome, valor, duracao_min')
    .eq('ativo', true)
    .eq('disponivel_online', true)
    .order('duracao_min', { ascending: true })
    .order('nome')
  return data || []
}

function menuServicos(servicos) {
  const n = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣']
  return servicos.map((s, i) =>
    `${n[i] || (i+1)+'.'} ${s.nome} — R$${Number(s.valor).toFixed(0)}`
  ).join('\n')
}


// ============================================================
// MENSAGENS PRÉ-CONFIGURADAS — edite aqui o tom e texto
// ============================================================
const MSG = {
  boas_vindas_historico: (nome, srv, uni, barb) =>
    `Olá, ${nome}! 😊\n\nNa última vez foi:\n✂️ ${srv}\n📍 ${uni}\n💈 ${barb}\n\nQuer marcar igual? Me conta o dia e horário que prefere!\n\nOu se quiser algo diferente, é só me dizer 😊`,

  boas_vindas_historico_parcial: (nome, linhas) =>
    `Olá, ${nome}! 😊 Já te conheço por aqui!\n\n${linhas}\n\nQuer agendar? Me conta o que você precisa e o horário 😊`,

  pede_nome: `Olá! 😊 Pode me dizer seu nome?`,

  boas_vindas_com_nome: (nome) => `Olá, ${nome}! 😊 Qual serviço você deseja?\n\n✂️ Corte de cabelo\n🪒 Corte + Barba\n🪒 Só a barba\n👶 Corte infantil`,

  boas_vindas: `Olá! 😊 Sou a assistente da Barbearia 1989.\n\nQual serviço você deseja?\n\n✂️ Corte de cabelo\n🪒 Corte + Barba\n🪒 Só a barba\n👶 Corte infantil`,

  pede_unidade: `Ótimo! Qual unidade prefere?\n\n📍 Timbaúva\n📍 Centro\n📍 São João`,

  pede_barbeiro: (nome) => nome ? `${nome}, tem preferência por algum barbeiro?` : `Tem preferência por algum barbeiro?`,

  pede_data: (nome) => nome ? `${nome}, qual dia e horário?` : `Qual dia e horário?`,

  nao_entendeu: `Desculpe, não entendi! 😅\nPode repetir de outra forma?`,

  nao_entendeu2: `Hmm, ainda não consegui entender 😅 Vou chamar um atendente pra te ajudar!`,

  fora_escopo: `Oi! Por aqui consigo ajudar apenas com agendamentos. Vou chamar um atendente para te atender! 😊`,

  sem_horarios: `Não encontrei horários disponíveis para esse período. Gostaria de tentar outro dia ou horário?`,

  confirma_agendamento: (d) =>
    `Confirme seu agendamento:\n\n` +
    `✂️ ${d.servico_nome}\n` +
    `📍 ${d.unidade_nome}\n` +
    `💈 ${d.barbeiro_nome}\n` +
    `📅 ${d.data_fmt} às ${d.hora_fmt}\n\n` +
    `Confirmar? Responda *sim* ou *não*`,

  agendado: (d) =>
    `Agendamento confirmado! 🎉\n\n` +
    `✂️ ${d.servico_nome}\n` +
    `📍 ${d.unidade_nome}\n` +
    `💈 ${d.barbeiro_nome}\n` +
    `📅 ${d.data_fmt} às ${d.hora_fmt}\n\n` +
    `Te esperamos! 🤝`,

  sem_horario_hoje: (barbeiro, unidade) =>
    `Com o ${barbeiro}, não temos mais horários para hoje 😔\n\nQuer ver um horário para amanhã com ele? Ou posso verificar se tem algum horário ainda hoje com outro barbeiro da ${unidade} 😊`,

  cancelado: `Tudo bem! Se precisar agendar, é só chamar 😊`,

  horario_indisponivel: (slots, podeBuscarOutroBarbeiro) => {
    const n = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣']
    return `Esse horário não está disponível 😔\n\nMas temos essas opções próximas:\n\n` +
      slots.map((s, i) => `${n[i] || (i+1)+'.'} ${s.label}`).join('\n') +
      (podeBuscarOutroBarbeiro
        ? `\n\nPode ser algum desses? Ou se preferir, digita *outro barbeiro* e busco quem tem disponível no horário que você quer 😊`
        : `\n\nQual prefere?`)
  },

  mostra_horarios: (slots) =>
    `Horários disponíveis:\n\n` +
    slots.map((s, i) => `${i + 1}. ${s.label}`).join('\n') +
    `\n\nQual prefere? Responda o número.`
}

// ============================================================
// Normaliza número
// ============================================================
function normalizeNumero(raw) {
  if (!raw) return null
  return raw.replace(/@.*/, '').replace(/\D/g, '')
}

// ============================================================
// Busca ou cria conversa — protegido contra duplicatas
// ============================================================
async function getOrCreateConversa(numero, nomeContato) {
  // Tenta buscar conversa aberta existente
  const { data: existente } = await supabaseAdmin
    .from('whatsapp_conversas')
    .select('*')
    .eq('numero', numero)
    .eq('status', 'aberta')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existente) {
    const upd = { nome_contato: nomeContato, ultima_msg_em: new Date().toISOString() }
    if (!existente.cliente_id) {
      const cli = await buscarClientePorNumero(numero)
      if (cli) { upd.cliente_id = cli.id; existente.cliente_id = cli.id }
    }
    await supabaseAdmin.from('whatsapp_conversas').update(upd).eq('id', existente.id)
    return existente
  }

  // Não existe conversa aberta → cria uma nova
  const cli = await buscarClientePorNumero(numero)
  const nova = {
    numero,
    nome_contato:  nomeContato,
    cliente_id:    cli ? cli.id : null,
    status:        'aberta',
    atendente:     'ia',
    estado_ia:     'inicial',
    dados_ia:      {},
    requer_humano: false,
    ultima_msg_em: new Date().toISOString()
  }

  const { data: criada, error: errInsert } = await supabaseAdmin.from('whatsapp_conversas')
    .insert(nova)
    .select('*')
    .single()

  if (errInsert) {
    // Pode ser conflito do índice único — busca a que já existe
    console.log('[getOrCreateConversa] insert falhou, buscando existente:', errInsert.message)
    const { data: recuperada } = await supabaseAdmin
      .from('whatsapp_conversas')
      .select('*')
      .eq('numero', numero)
      .eq('status', 'aberta')
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    return recuperada
  }

  return criada
}

// ============================================================
// Busca cliente pelo número via função SQL
// ============================================================
async function buscarClientePorNumero(numero) {
  try {
    const { data } = await supabaseAdmin.rpc('buscar_cliente_por_telefone', { tel: numero })
    return (data && data[0]) || null
  } catch (e) {
    return null
  }
}

// ============================================================
// ============================================================
// Salva mensagens ENVIADAS pelo número da barbearia (fromMe).
// Cobre respostas manuais feitas pelo celular / WhatsApp Web — antes
// eram descartadas e a tela do sistema só mostrava cliente + IA.
// As mensagens da própria IA já são salvas pela função enviar(); aqui
// a checagem por evolution_msg_id evita duplicar.
// ============================================================
async function salvarMensagemEnviada(data) {
  try {
    const jid = data.key?.remoteJid || ''
    if (jid.includes('@g.us') || jid.includes('@broadcast')) return  // ignora grupos e status
    const numero = normalizeNumero(jid)
    if (!numero || !data.message) return

    // Se já existe (foi a IA/sistema que mandou via enviar()), não duplica
    const msgId = data.key?.id || null
    if (msgId) {
      const { data: jaExiste } = await supabaseAdmin.from('whatsapp_mensagens')
        .select('id').eq('evolution_msg_id', msgId).limit(1).maybeSingle()
      if (jaExiste) return
    }

    let tipo = 'texto', conteudo = null, midiaUrl = null
    if (data.message.conversation)              { conteudo = data.message.conversation }
    else if (data.message.extendedTextMessage)  { conteudo = data.message.extendedTextMessage.text }
    else if (data.message.audioMessage)         { tipo = 'audio'; conteudo = '[áudio]'; midiaUrl = data.message.audioMessage?.url }
    else if (data.message.imageMessage)         { tipo = 'imagem'; conteudo = data.message.imageMessage?.caption || '[imagem]'; midiaUrl = data.message.imageMessage?.url }
    else                                        { conteudo = '[mensagem não suportada]' }

    // Busca conversa aberta SEM sobrescrever nome_contato
    // (no fromMe o pushName é o nome da barbearia, não do cliente)
    let { data: conversa } = await supabaseAdmin.from('whatsapp_conversas')
      .select('id')
      .eq('numero', numero).eq('status', 'aberta')
      .order('criado_em', { ascending: false })
      .limit(1).maybeSingle()

    // Barbearia iniciou a conversa manualmente → cria já em modo humano
    // (senão a IA entraria no meio quando o cliente respondesse)
    if (!conversa) {
      const cli = await buscarClientePorNumero(numero)
      const { data: criada } = await supabaseAdmin.from('whatsapp_conversas')
        .insert({
          numero,
          nome_contato:  (cli && cli.nome) || numero,
          cliente_id:    cli ? cli.id : null,
          status:        'aberta',
          atendente:     'humano',
          estado_ia:     'inicial',
          dados_ia:      {},
          requer_humano: true,
          ultima_msg_em: new Date().toISOString()
        })
        .select('id').single()
      conversa = criada
    }
    if (!conversa) return

    await supabaseAdmin.from('whatsapp_mensagens').upsert({
      conversa_id:      conversa.id,
      evolution_msg_id: msgId,
      direcao:          'saida',
      tipo, conteudo, midia_url: midiaUrl,
      remetente:        'humano'
    }, { onConflict: 'evolution_msg_id', ignoreDuplicates: true })

    await supabaseAdmin.from('whatsapp_conversas')
      .update({ ultima_msg_em: new Date().toISOString() })
      .eq('id', conversa.id)
  } catch (e) {
    console.error('[salvarMensagemEnviada]', e.message)
  }
}

// POST /whatsapp/webhook
// ============================================================
router.post('/webhook', async (req, res) => {
  try {
    res.status(200).json({ ok: true })

    const body  = req.body || {}
    const event = body.event || ''
    const data  = body.data  || {}

    if (event !== 'messages.upsert') return
    if (data.key?.fromMe) { await salvarMensagemEnviada(data); return }
    if (!data.message)    return

    const numero      = normalizeNumero(data.key?.remoteJid)
    const nomeContato = data.pushName || numero
    if (!numero) return

    let tipo = 'texto', conteudo = null, midiaUrl = null
    if (data.message.conversation)              { conteudo = data.message.conversation }
    else if (data.message.extendedTextMessage)  { conteudo = data.message.extendedTextMessage.text }
    else if (data.message.audioMessage)         { tipo = 'audio'; conteudo = '[áudio]'; midiaUrl = data.message.audioMessage?.url }
    else if (data.message.imageMessage)         { tipo = 'imagem'; conteudo = data.message.imageMessage?.caption || '[imagem]'; midiaUrl = data.message.imageMessage?.url }
    else                                        { conteudo = '[mensagem não suportada]' }

    const conversa = await getOrCreateConversa(numero, nomeContato)
    if (!conversa) return

    // Salva mensagem
    await supabaseAdmin.from('whatsapp_mensagens')
      .upsert({
        conversa_id:      conversa.id,
        evolution_msg_id: data.key?.id || null,
        direcao:          'entrada',
        tipo, conteudo, midia_url: midiaUrl,
        remetente:        'cliente'
      }, { onConflict: 'evolution_msg_id', ignoreDuplicates: true })

    // Log de diagnóstico
    console.log(`[webhook] numero=${numero} tipo=${tipo} atendente=${conversa.atendente} requer_humano=${conversa.requer_humano} estado=${conversa.estado_ia} conteudo=${conteudo?.slice(0,50)}`)

    // Só processa com IA se ativa (configurações no banco) e não requer humano
    if (conversa.atendente === 'ia' && !conversa.requer_humano && conteudo && tipo === 'texto') {
      const { data: cfgIA } = await supabaseAdmin
        .from('configuracoes')
        .select('valor')
        .eq('chave', 'whatsapp_ia_ativa')
        .maybeSingle()
      console.log(`[webhook] ia_ativa=${cfgIA?.valor}`)
      if (cfgIA?.valor === 'true') {
        console.log('[webhook] chamando processarFluxo...')
        await processarFluxo(conversa, conteudo)
      }
    } else {
      console.log(`[webhook] IA não processou — atendente=${conversa.atendente} requer_humano=${conversa.requer_humano} tipo=${tipo} temConteudo=${!!conteudo}`)
    }

  } catch (e) {
    console.error('[whatsapp/webhook]', e.message)
  }
})

// ============================================================
// FLUXO EM 4 FASES
// ============================================================
async function processarFluxo(conversa, mensagemCliente) {
  const fase  = conversa.estado_ia || 'fase1'
  const dados = conversa.dados_ia  || {}
  const nome  = dados._nome || dados._nome_cliente || null

  console.log(`[fluxo] fase=${fase} msg="${mensagemCliente?.slice(0,50)}"`)

  try {

    // ══════════════════════════════════════════════════════
    // FASE 1 — SAUDAÇÃO E IDENTIFICAÇÃO
    // ══════════════════════════════════════════════════════

    if (fase === 'fase1') {
      // Tenta extrair info da mensagem já na abertura
      const ext = await extrairTudo(mensagemCliente)
      if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }

      // Preenche o que veio na primeira mensagem
      if (ext.servico)  { dados.servico_raw = ext.servico;  dados.servico_nome  = nomearServico(ext.servico) }
      if (ext.unidade)  { dados.unidade_raw = ext.unidade;  dados.unidade_nome  = nomearUnidade(ext.unidade) }
      if (ext.barbeiro && ext.barbeiro !== 'sem_preferencia') dados.barbeiro_raw = ext.barbeiro
      if (ext.data)     dados.data_raw  = ext.data
      if (ext.hora)     dados.hora_raw  = ext.hora
      if (ext.periodo)  dados.periodo   = ext.periodo

      // Cliente identificado pelo número?
      if (conversa.cliente_id) {
        const ctx = await buscarContextoCliente(conversa.cliente_id)
        if (ctx) {
          dados._nome = ctx.nome
          // Pré-preenche histórico se cliente não mandou preferências
          if (!dados.servico_raw  && ctx.ultimo_servico)   { dados.servico_raw  = 'historico'; dados.servico_nome  = ctx.ultimo_servico }
          if (!dados.unidade_raw  && ctx.ultima_unidade)   { dados.unidade_raw  = ctx.ultima_unidade.toLowerCase(); dados.unidade_nome  = ctx.ultima_unidade; dados.unidade_id   = ctx.ultima_unidade_id }
          if (!dados.barbeiro_raw && ctx.ultimo_barbeiro)  { dados.barbeiro_raw = ctx.ultimo_barbeiro; dados.barbeiro_nome = ctx.ultimo_barbeiro; dados.barbeiro_id  = ctx.ultimo_barbeiro_id }
          dados._usando_historico = true

          // Se tem histórico completo → oferece repetir
          if (dados._usando_historico && ctx.ultimo_servico && ctx.ultima_unidade && ctx.ultimo_barbeiro && !ext.data && !ext.hora && !ext.periodo) {
            await enviar(conversa, MSG.boas_vindas_historico(ctx.nome, ctx.ultimo_servico, ctx.ultima_unidade, ctx.ultimo_barbeiro))
            await setFase(conversa.id, 'fase3', dados)
            return
          }
        }
      }

      // Não identificado → pede nome (se mensagem só tem saudação)
      if (!dados._nome && !dados.servico_raw && !dados.unidade_raw) {
        await enviar(conversa, MSG.pede_nome)
        await setFase(conversa.id, 'fase1_nome', dados)
        return
      }

      // Tem nome ou info suficiente → vai pra fase 2
      await irParaFase2(conversa, dados)
      return
    }

    if (fase === 'fase1_nome') {
      const nome = mensagemCliente.trim().split(' ').slice(0,2).join(' ')
      if (nome.length < 2) { await erroOuEscalar(conversa, dados, `Não entendi seu nome 😅 Como você se chama?`); return }
      dados._nome = nome
      dados._erros = 0
      await irParaFase2(conversa, dados)
      return
    }

    // ══════════════════════════════════════════════════════
    // FASE 2 — SERVIÇO + UNIDADE + BARBEIRO
    // ══════════════════════════════════════════════════════

    if (fase === 'fase2_servico') {
      const servicos = dados._servicos || await carregarServicos()
      const msg = mensagemCliente.toLowerCase()

      // Tenta escolha por número
      const numStr = mensagemCliente.trim().replace(/[^0-9]/g, '')
      const numIdx = parseInt(numStr) - 1
      let servicoEscolhido = (!isNaN(numIdx) && numIdx >= 0 && numIdx < servicos.length)
        ? servicos[numIdx] : null

      // Se não escolheu por número, tenta por nome
      if (!servicoEscolhido) {
        servicoEscolhido = servicos.find(s =>
          msg.includes(s.nome.toLowerCase().split(' ')[0]) ||
          s.nome.toLowerCase().split(' ').some(p => p.length > 3 && msg.includes(p))
        )
      }

      // Fallback: extrai com Gemini e mapeia
      if (!servicoEscolhido) {
        const ext = await extrairTudo(mensagemCliente)
        if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }
        if (ext.servico) {
          const mapa = { corte: 'cabelo', corte_barba: 'barba', barba: 'barba', infantil: 'cabelo' }
          const chave = mapa[ext.servico] || ext.servico
          servicoEscolhido = servicos.find(s => s.nome.toLowerCase().includes(chave))
        }
      }

      if (!servicoEscolhido) { await erroOuEscalar(conversa, dados, MSG.nao_entendeu); return }

      dados.servico_raw      = 'db'
      dados.servico_id       = servicoEscolhido.id
      dados.servico_nome     = servicoEscolhido.nome
      dados.servico_valor    = Number(servicoEscolhido.valor)
      dados.servico_duracao  = servicoEscolhido.duracao_min

      // Extrai mais info se veio junto
      const ext = await extrairTudo(mensagemCliente)
      if (ext.unidade)  { dados.unidade_raw = ext.unidade; dados.unidade_nome = nomearUnidade(ext.unidade) }
      if (ext.barbeiro && ext.barbeiro !== 'sem_preferencia') dados.barbeiro_raw = ext.barbeiro
      if (ext.data)     dados.data_raw = ext.data
      if (ext.hora)     dados.hora_raw = ext.hora
      if (ext.periodo)  dados.periodo  = ext.periodo
      dados._erros = 0
      await irParaFase2(conversa, dados)
      return
    }

    if (fase === 'fase2_unidade') {
      const ext = await extrairTudo(mensagemCliente)
      if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }
      if (!ext.unidade) { await erroOuEscalar(conversa, dados, MSG.nao_entendeu); return }
      dados.unidade_raw  = ext.unidade
      dados.unidade_nome = nomearUnidade(ext.unidade)
      const { data: uni } = await supabaseAdmin.from('unidades').select('id').ilike('nome', `%${dados.unidade_nome}%`).limit(1).maybeSingle()
      if (uni) dados.unidade_id = uni.id
      if (ext.barbeiro && ext.barbeiro !== 'sem_preferencia') dados.barbeiro_raw = ext.barbeiro
      if (ext.data)    dados.data_raw = ext.data
      if (ext.hora)    dados.hora_raw = ext.hora
      if (ext.periodo) dados.periodo  = ext.periodo
      dados._erros = 0
      // Verifica se tinha barbeiro pendente de outra unidade
      if (dados._barbeiro_pendente_id && dados._barbeiro_pendente_uni === dados.unidade_nome) {
        dados.barbeiro_id   = dados._barbeiro_pendente_id
        dados.barbeiro_nome = dados._barbeiro_pendente_nome
        dados._barbeiro_pendente_id = null; dados._barbeiro_pendente_nome = null; dados._barbeiro_pendente_uni = null
      }
      await irParaFase2(conversa, dados)
      return
    }

    if (fase === 'fase2_barbeiro') {
      const msg = mensagemCliente.toLowerCase()
      const raw = String(mensagemCliente || '').trim()
      const lista = dados._barbeiros_lista || []

      // "não lembro quem me atende" → foto-painel da unidade + reapresenta a lista
      if (raw === 'nao_lembro' || /n[ãa]o lembro|n[ãa]o sei o nome|esqueci o nome/.test(msg)) {
        const painel = painelDaUnidade(dados.unidade_nome)
        if (painel) await enviarImagem(conversa, painel, `Estes são os barbeiros da ${dados.unidade_nome} 💈 Reconheceu? É só tocar no nome na lista 👇`)
        else await enviar(conversa, `Dá uma olhada nas fotos em barbearia1989.com.br e me diz o nome 😊`)
        await mostrarListaBarbeiros(conversa, dados)
        return
      }
      // "sem preferência" (clique, frase, ou número da opção)
      if (raw === 'sem_pref' || /sem prefer|qualquer|tanto faz|pode ser|n[ãa]o tenho/.test(msg)) {
        dados.sem_preferencia = true; dados.barbeiro_id = null; dados.barbeiro_nome = null; dados._erros = 0
        await irParaFase3(conversa, dados); return
      }
      // clique num barbeiro (rowId 'barb:ID') ou número digitado (lista virou texto)
      let idClicado = raw.startsWith('barb:') ? raw.slice(5) : null
      if (!idClicado && /^\d+$/.test(raw)) {
        const n = parseInt(raw, 10)
        if (n >= 1 && n <= lista.length) idClicado = lista[n - 1].id
        else if (n === lista.length + 1) { dados.sem_preferencia = true; dados.barbeiro_id = null; dados.barbeiro_nome = null; await irParaFase3(conversa, dados); return }
        else if (n === lista.length + 2) { const p = painelDaUnidade(dados.unidade_nome); if (p) await enviarImagem(conversa, p, `Barbeiros da ${dados.unidade_nome} 💈`); await mostrarListaBarbeiros(conversa, dados); return }
      }
      if (idClicado) {
        const b = lista.find(x => String(x.id) === String(idClicado))
        if (b) { dados.barbeiro_id = b.id; dados.barbeiro_nome = b.nome; dados._erros = 0; await irParaFase3(conversa, dados); return }
      }

      const ext = await extrairTudo(mensagemCliente)
      if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }

      // Cliente diz que TEM preferência mas não falou o nome
      if (/\btenho\b|\bquero\b|\bprefiro\b/.test(msg) && !ext.barbeiro) {
        await enviar(conversa, `Qual o nome do barbeiro? 😊`)
        return
      }

      // Se Gemini não extraiu nome mas msg não parece "sem preferência" → usa msg como nome
      const semPref = /sem prefer|qualquer|tanto faz|pode ser|nao tenho|não tenho/.test(msg)
      const nomeBarbeiro = ext.barbeiro || (!semPref && mensagemCliente.trim().length < 30 ? mensagemCliente.trim() : null)

      if (!nomeBarbeiro || nomeBarbeiro === 'sem_preferencia') {
        dados.barbeiro_id   = null
        dados.barbeiro_nome = 'Mais disponível'
      } else {
        const colQ = supabaseAdmin.from('colaboradores').select('id,nome').eq('ativo', true).neq('perfil','caixa').ilike('nome', `%${nomeBarbeiro}%`).limit(1)
        if (dados.unidade_id) colQ.eq('unidade_id', dados.unidade_id)
        const { data: col } = await colQ.maybeSingle()
        if (col) {
          dados.barbeiro_id   = col.id
          dados.barbeiro_nome = col.nome
        } else {
          // Busca em outras unidades
          const { data: colOutra } = await supabaseAdmin.from('colaboradores')
            .select('id,nome,unidades(nome)').eq('ativo', true).neq('perfil','caixa').ilike('nome', `%${nomeBarbeiro}%`).limit(1).maybeSingle()
          if (colOutra) {
            const uniDele = colOutra.unidades?.nome || 'outra unidade'
            dados._barbeiro_pendente_id   = colOutra.id
            dados._barbeiro_pendente_nome = colOutra.nome
            dados._barbeiro_pendente_uni  = uniDele
            await enviar(conversa, `O ${colOutra.nome} é barbeiro da unidade ${uniDele}, não da ${dados.unidade_nome} 😊\n\nEm qual unidade você quer ser atendido?\n\n📍 Timbaúva\n📍 Centro\n📍 São João`)
            await setFase(conversa.id, 'fase2_unidade', dados)
            return
          } else {
            await enviar(conversa, `Não encontrei o ${nomeBarbeiro} em nenhuma unidade 😔 Tem preferência por outro barbeiro?`)
            return
          }
        }
      }

      if (ext.data)    dados.data_raw = ext.data
      if (ext.hora)    dados.hora_raw = ext.hora
      if (ext.periodo) dados.periodo  = ext.periodo
      dados._erros = 0
      await irParaFase3(conversa, dados)
      return
    }

    // ══════════════════════════════════════════════════════
    // FASE 3 — BUSCA E ESCOLHA DE HORÁRIO
    // ══════════════════════════════════════════════════════

    if (fase === 'fase3') {
      const ext = await extrairTudo(mensagemCliente)
      if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }

      // Detecta mudança de serviço/unidade/barbeiro
      if (ext.servico && ext.servico !== dados.servico_raw) { dados.servico_raw = ext.servico; dados.servico_nome = nomearServico(ext.servico) }
      if (ext.unidade) { dados.unidade_raw = ext.unidade; dados.unidade_nome = nomearUnidade(ext.unidade) }
      if (ext.barbeiro && ext.barbeiro !== 'sem_preferencia') dados.barbeiro_raw = ext.barbeiro

      if (ext.data || ext.hora || ext.periodo) {
        dados.data_raw  = ext.data   || null
        dados.hora_raw  = ext.hora   || null
        dados.periodo   = ext.periodo || null
        dados._erros = 0
        await buscarEMostrarSlots(conversa, dados)
      } else {
        await responder(conversa, 'nao_entendeu', { nome: dados._nome, ultima_msg: mensagemCliente }, MSG.pede_data(dados._nome))
        await supabaseAdmin.from('whatsapp_conversas').update({ dados_ia: dados }).eq('id', conversa.id)
      }
      return
    }

    if (fase === 'fase3_slots') {
      const msg = mensagemCliente.toLowerCase()
      const slots = dados._slots || []

      // Quer outro barbeiro hoje
      if (dados._sem_horario_hoje && /outro|hoje/.test(msg)) {
        if (dados.unidade_id && dados.barbeiro_id) {
          const { data: cols } = await supabaseAdmin.from('colaboradores')
            .select('id,nome').eq('ativo', true).neq('perfil','caixa').eq('unidade_id', dados.unidade_id).neq('id', dados.barbeiro_id)
          if (cols && cols.length > 0) {
            const hoje = new Date().toISOString().slice(0,10)
            const slotsHoje = await buscarSlots({ ...dados, barbeiro_id: cols[0].id, data_raw: hoje, hora_raw: null })
            if (slotsHoje && slotsHoje.length > 0) {
              dados._slots = slotsHoje
              dados._sem_horario_hoje = false
              await enviar(conversa, `Encontrei esses horários ainda hoje:\n\n` + MSG.mostra_horarios(slotsHoje))
              await setFase(conversa.id, 'fase3_slots', dados)
              return
            }
          }
          await enviar(conversa, `Não há mais horários hoje em nenhum barbeiro 😔 Quer ver para amanhã?`)
          return
        }
      }

      // Quer amanhã (quando sem_horario_hoje)
      if (dados._sem_horario_hoje && /amanha|amanhã|sim|pode|ok/.test(msg)) {
        const slotsAmanha = dados._slots_amanha || []
        if (slotsAmanha.length > 0) {
          dados._slots = slotsAmanha
          dados._sem_horario_hoje = false
          dados._slots_amanha = null
          await enviar(conversa, MSG.mostra_horarios(slotsAmanha))
          await setFase(conversa.id, 'fase3_slots', dados)
        } else {
          await enviar(conversa, MSG.sem_horarios)
          await setFase(conversa.id, 'fase3', { ...dados, data_raw: null, hora_raw: null })
        }
        return
      }

      // Detecta se o cliente quer ver outro período ou dia
      const msg3 = mensagemCliente.toLowerCase()
      const querOutroPeriodo = /tarde|manhã|manha|noite|amanhã|amanha|outro dia|outra hora/.test(msg3)
      if (querOutroPeriodo) {
        const ext = await extrairTudo(mensagemCliente)
        if (ext.periodo || ext.data || ext.hora) {
          dados.periodo  = ext.periodo  || null
          dados.data_raw = ext.data     || dados.data_raw
          dados.hora_raw = ext.hora     || null
          dados._slots   = null
          await buscarEMostrarSlots(conversa, dados)
          return
        }
      }

      // Escolha por número — parseia direto da mensagem
      const numStr = mensagemCliente.trim().replace(/[^0-9]/g, '')
      const idx    = parseInt(numStr) - 1
      if (!isNaN(idx) && idx >= 0 && idx < slots.length) {
        const slot = slots[idx]
        dados._slot  = slot
        dados.barbeiro_id    = slot.colaborador_id
        dados.barbeiro_nome  = slot.barbeiro_nome
        dados.data_fmt       = slot.data_fmt
        dados.hora_fmt       = slot.hora_fmt
        dados._erros = 0
        await enviar(conversa, MSG.confirma_agendamento(dados))
        await setFase(conversa.id, 'fase4', dados)
      } else {
        await erroOuEscalar(conversa, dados, `Escolha um número entre 1 e ${slots.length} 😊`)
      }
      return
    }

    // ══════════════════════════════════════════════════════
    // FASE 4 — CONFIRMAÇÃO E AGENDAMENTO
    // ══════════════════════════════════════════════════════

    if (fase === 'fase4') {
      const msg = mensagemCliente.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      const confirmou = /\bsim\b|\bpode\b|\bconfirmo\b|\bok\b|\bclaro\b|\bisso\b/.test(msg)
      const cancelou  = /\bnao\b|\bcancela\b|\bdesistir\b|\bnope\b/.test(msg)

      if (confirmou) {
        const resultado = await fazerAgendamento(conversa, dados)
        if (!resultado || !resultado.ok) {
          const erroMsg = resultado?.erro || 'erro desconhecido'
          await escalarHumano(conversa, `Erro ao agendar: ${erroMsg} 😔`)
          return
        }
        if (resultado.ok) {
          // Monta mensagem com link de acesso direto
          let msgFinal = MSG.agendado(dados)

          const cidFinal = dados._cliente_id || conversa.cliente_id
          if (cidFinal) {
            const nomeCliente = dados._nome || conversa.nome_contato || ''
            const token = gerarTokenApp(cidFinal, nomeCliente)
            if (token) {
              const link = `https://barbearia1989.com.br/?token=${token}`
              if (dados._cliente_novo) {
                msgFinal += `\n\n🎉 Criamos seu cadastro na Barbearia 1989!\nSenha padrão: *123456*\n\nPelo link abaixo você acessa seus agendamentos e agenda direto na próxima vez — sem precisar falar com a gente:\n👉 ${link}`
              } else {
                msgFinal += `\n\nPela próxima vez, você pode agendar direto pelo app — mais rápido e sem fila 😊\n👉 ${link}`
              }
            }
          }

          await enviar(conversa, msgFinal)
          await setFase(conversa.id, 'fase4_concluido', dados)
        }
      } else if (cancelou) {
        await enviar(conversa, MSG.cancelado)
        await setFase(conversa.id, 'fase1', {})
      } else {
        await erroOuEscalar(conversa, dados, `Responda *sim* para confirmar ou *não* para cancelar 😊`)
      }
      return
    }

    if (fase === 'fase4_concluido') {
      // Conversa encerrada — não responde automaticamente
      return
    }

    // Estado desconhecido → reinicia
    await setFase(conversa.id, 'fase1', {})
    await processarFluxo({ ...conversa, estado_ia: 'fase1', dados_ia: {} }, mensagemCliente)

  } catch (e) {
    console.error('[fluxo] erro na fase', fase, ':', e.message, e.stack?.slice(0,200))
    await escalarHumano(conversa, `Erro técnico [${fase}]: ${e.message?.slice(0,80)} 😔`)
  }
}

// ── Lógica de avanço da Fase 2 (verifica o que já tem e pula etapas) ──
async function mostrarListaBarbeiros(conversa, dados) {
  const { data: barbs } = await supabaseAdmin.from('colaboradores')
    .select('id, nome').eq('ativo', true).neq('perfil', 'caixa')
    .eq('unidade_id', dados.unidade_id).order('nome')
  dados._barbeiros_lista = (barbs || []).map(b => ({ id: b.id, nome: b.nome }))
  const rows = (barbs || []).map(b => ({ title: b.nome, rowId: 'barb:' + b.id }))
  rows.push({ title: 'Sem preferência', description: 'Marco com quem estiver mais livre', rowId: 'sem_pref' })
  rows.push({ title: 'Não lembro quem me atende', description: 'Te mostro as fotos pra reconhecer', rowId: 'nao_lembro' })
  await enviarLista(conversa, {
    title: 'Escolha o barbeiro',
    description: (dados._nome ? dados._nome + ', com' : 'Com') + ` quem você quer marcar na unidade ${dados.unidade_nome}?`,
    buttonText: 'Ver barbeiros',
    rows
  })
}

async function irParaFase2(conversa, dados) {
  const nome = dados._nome || null

  // Resolve unidade_id se ainda não tem
  if (dados.unidade_raw && !dados.unidade_id) {
    const { data: uni } = await supabaseAdmin.from('unidades').select('id').ilike('nome', `%${dados.unidade_nome}%`).limit(1).maybeSingle()
    if (uni) dados.unidade_id = uni.id
  }
  // Resolve barbeiro_id se tem nome mas não tem id
  if (dados.barbeiro_raw && !dados.barbeiro_id && dados.barbeiro_raw !== 'historico') {
    const colQ = supabaseAdmin.from('colaboradores').select('id,nome').eq('ativo', true).neq('perfil','caixa').ilike('nome', `%${dados.barbeiro_raw}%`).limit(1)
    if (dados.unidade_id) colQ.eq('unidade_id', dados.unidade_id)
    const { data: col } = await colQ.maybeSingle()
    if (col) { dados.barbeiro_id = col.id; dados.barbeiro_nome = col.nome }
  }

  const ctx = { nome, servico: dados.servico_nome, unidade: dados.unidade_nome, barbeiro: dados.barbeiro_nome, ultima_msg: '', tem_historico: !!dados._usando_historico }

  if (!dados.servico_raw) {
    const opcoes = '✂️ Corte de cabelo\n🪒 Corte + Barba\n🪒 Só a barba\n👶 Corte infantil'
    const fallback = nome ? `Olá, ${nome}! 😊 Qual serviço você deseja?` : `Olá! 😊 Qual serviço você deseja?`
    await responder(conversa, 'pede_servico', ctx, fallback, opcoes)
    await setFase(conversa.id, 'fase2_servico', dados)
    return
  }
  if (!dados.unidade_raw) {
    const opcoes = '📍 Timbaúva\n📍 Centro\n📍 São João'
    await responder(conversa, 'pede_unidade', { ...ctx, servico: dados.servico_nome }, `Ótimo! Qual unidade prefere?`, opcoes)
    await setFase(conversa.id, 'fase2_unidade', dados)
    return
  }
  if (dados.barbeiro_id === undefined && !dados.barbeiro_raw && !dados.sem_preferencia) {
    await mostrarListaBarbeiros(conversa, dados)
    await setFase(conversa.id, 'fase2_barbeiro', dados)
    return
  }
  // Tudo coletado → fase 3
  await irParaFase3(conversa, dados)
}

async function irParaFase3(conversa, dados) {
  if (dados.data_raw || dados.hora_raw || dados.periodo) {
    await buscarEMostrarSlots(conversa, dados)
  } else {
        const ctxD = { nome: dados._nome, servico: dados.servico_nome, unidade: dados.unidade_nome, barbeiro: dados.barbeiro_nome, tem_historico: !!dados._usando_historico }
    await responder(conversa, 'pede_data', ctxD, MSG.pede_data(dados._nome))
    await setFase(conversa.id, 'fase3', dados)
  }
}

async function buscarEMostrarSlots(conversa, dados) {
  const slots = await buscarSlots(dados)

  if (!slots || slots.length === 0) {
    // Tenta dia seguinte
    const dataAtual = dados.data_raw ? new Date(dados.data_raw + 'T12:00:00') : new Date()
    dataAtual.setDate(dataAtual.getDate() + 1)
    const proximoDia = dataAtual.toISOString().slice(0,10)
    const slotsProximo = await buscarSlots({ ...dados, data_raw: proximoDia, hora_raw: null })
    if (slotsProximo && slotsProximo.length > 0) {
      dados._slots = slotsProximo
      await enviar(conversa, `Não há horários disponíveis nesse dia 😔\n\n` + MSG.mostra_horarios(slotsProximo))
      await setFase(conversa.id, 'fase3_slots', dados)
    } else {
      await enviar(conversa, MSG.sem_horarios)
      await setFase(conversa.id, 'fase3', { ...dados, data_raw: null, hora_raw: null })
    }
    return
  }

  const temExato = dados.hora_raw && slots.some(s => s.hora_iso === dados.hora_raw)
  const podeBuscarOutro = !temExato && dados.hora_raw && !!dados.barbeiro_id

  if (dados._sem_horario_hoje) {
    dados._slots_amanha = slots
    await enviar(conversa, MSG.sem_horario_hoje(dados.barbeiro_nome || 'este barbeiro', dados.unidade_nome || 'sua unidade'))
    await setFase(conversa.id, 'fase3_slots', dados)
    return
  }

  dados._slots = slots
  dados._pode_buscar_outro = podeBuscarOutro
  const msgSlots = !temExato && dados.hora_raw
    ? MSG.horario_indisponivel(slots, podeBuscarOutro)
    : MSG.mostra_horarios(slots)
  await enviar(conversa, msgSlots)
  await setFase(conversa.id, 'fase3_slots', dados)
}

async function setFase(id, fase, dados) {
  await supabaseAdmin.from('whatsapp_conversas').update({ estado_ia: fase, dados_ia: dados }).eq('id', id)
}


// ============================================================
// Gemini gera texto natural — código controla estrutura e opções
// ============================================================
async function gerarResposta(tipo, ctx) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_KEY) return null // fallback para mensagem padrão

  const tarefas = {
    pede_servico:   `Pergunte qual serviço o cliente deseja. Não liste os serviços (eles serão adicionados automaticamente).`,
    pede_unidade:   `O cliente escolheu "${ctx.servico}". Pergunte qual unidade prefere de forma natural.`,
    pede_barbeiro:  `O cliente vai para a ${ctx.unidade}. Pergunte se tem preferência por algum barbeiro.`,
    pede_data:      `Coleta: serviço=${ctx.servico}, unidade=${ctx.unidade}, barbeiro=${ctx.barbeiro}. Pergunte o dia e horário de forma natural.`,
    confirma_slot:  `O cliente escolheu o horário. Mostre o resumo do agendamento e peça confirmação.`,
    nao_entendeu:   `Não entendeu a mensagem "${ctx.ultima_msg}". Peça para o cliente repetir de forma gentil.`,
    fora_escopo:    `O cliente falou sobre algo que não é agendamento ("${ctx.ultima_msg}"). Explique gentilmente que só pode ajudar com agendamentos e que vai chamar um atendente.`
  }

  const prompt = `Você é a atendente virtual da Barbearia 1989 em Montenegro/RS. Tom: simpático, informal, como a atendente real da barbearia.

CONTEXTO ATUAL:
- Cliente: ${ctx.nome || 'não identificado'}
- Última mensagem do cliente: "${ctx.ultima_msg || ''}"
- Serviço: ${ctx.servico || '—'}
- Unidade: ${ctx.unidade || '—'}
- Barbeiro: ${ctx.barbeiro || '—'}
- Tem histórico na barbearia: ${ctx.tem_historico ? 'sim' : 'não'}

TAREFA: ${tarefas[tipo] || tipo}

REGRAS:
- Máximo 2 linhas curtas
- Use o nome do cliente quando souber
- Não liste opções (serão adicionadas automaticamente)
- Não invente dados
- Emoji leve só se encaixar bem
- Responda APENAS o texto da mensagem, sem explicação`

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 80 }
        })
      }
    )
    const gdata = await resp.json()
    if (gdata.error) return null
    const texto = gdata?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    return texto || null
  } catch (e) {
    return null
  }
}

// Gera resposta com fallback para mensagem padrão
async function responder(conversa, tipo, ctx, fallback, sufixo = '') {
  const gerado = await gerarResposta(tipo, ctx)
  const texto  = (gerado || fallback) + (sufixo ? '\n\n' + sufixo : '')
  await enviar(conversa, texto)
}

// ============================================================
// Extrai TUDO de uma vez — para quando cliente manda mensagem completa
// ============================================================
async function extrairTudo(mensagem) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_KEY) return {}

  const hoje = new Date()
  const amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1)
  const dias = ['domingo','segunda','terça','quarta','quinta','sexta','sábado']

  // Calcula próximas segundas, terças, etc.
  const datasReferencia = {}
  for (let i = 0; i <= 7; i++) {
    const d = new Date(hoje); d.setDate(hoje.getDate() + i)
    datasReferencia[dias[d.getDay()]] = d.toISOString().slice(0,10)
  }

  const prompt = `Você extrai dados de agendamento de mensagens de WhatsApp de uma barbearia.

Regras para o campo "servico":
- Se mencionar corte, cabelo, cabelinho, aparar, tesoura → "corte"
- Se mencionar corte e barba juntos → "corte_barba"
- Se mencionar só barba, bigode → "barba"
- Se mencionar infantil, criança, filho, bebê, menino, menina → "infantil"
- Se não mencionar nenhum serviço → null

Regras para "unidade":
- Timbaúva, timbauva → "timbauva"
- Centro, central → "centro"
- São João, sao joao, boark, buarque, barbearia da buarque, unidade da buarque → "sao_joao"
- Se não mencionar → null

Regras para "barbeiro": nome do profissional mencionado, ou null

Regras para data/hora:
- Hoje: ${hoje.toLocaleDateString('pt-BR')} (${dias[hoje.getDay()]})
- Amanhã: ${amanha.toLocaleDateString('pt-BR')}
- ${Object.entries(datasReferencia).map(([d,v]) => `${d} = ${v}`).join(', ')}
- Converta para "YYYY-MM-DD" e "HH:MM"
- "de manhã" → periodo "manha", "à tarde" → "tarde", "à noite" → "noite"

Regras para "fora_escopo": true APENAS se o assunto não tiver NADA a ver com barbearia ou agendamento.

Retorne SOMENTE um JSON sem comentários, sem explicação, sem markdown:
{"servico":null,"unidade":null,"barbeiro":null,"data":null,"hora":null,"periodo":null,"fora_escopo":false}

Mensagem a analisar: "${mensagem}"`

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=\${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 150 }
        })
      }
    )
    const gdata = await resp.json()
    let raw = gdata?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}'
    raw = raw.replace(/```json|```/g, '').replace(/\/\/[^\n]*/g, '').trim()
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) raw = match[0]
    const parsed = JSON.parse(raw)

    // Reforça com palavras-chave — garante que termos óbvios sejam reconhecidos
    const msg = mensagem.toLowerCase()
    if (!parsed.servico) {
      if (/corte.{0,15}barba|barba.{0,15}corte/.test(msg)) parsed.servico = 'corte_barba'
      else if (/infant|crian|filho|filha|bebe|bebê|menin/.test(msg)) parsed.servico = 'infantil'
      else if (/\bbarba\b|\bbigode\b/.test(msg)) parsed.servico = 'barba'
      else if (/cort|cabel|aparar|tesoura/.test(msg)) parsed.servico = 'corte'
    }
    if (!parsed.unidade) {
      if (/timba/.test(msg)) parsed.unidade = 'timbauva'
      else if (/\bcentro\b/.test(msg)) parsed.unidade = 'centro'
      else if (/joao|joão|boark/.test(msg)) parsed.unidade = 'sao_joao'
    }
    if (!parsed.periodo) {
      if (/manh/.test(msg)) parsed.periodo = 'manha'
      else if (/tarde/.test(msg)) parsed.periodo = 'tarde'
      else if (/noite/.test(msg)) parsed.periodo = 'noite'
    }
    if (!parsed.hora) {
      const h = msg.match(/(\d{1,2})\s*[h:](\d{0,2})/)
      if (h) parsed.hora = `${h[1].padStart(2,'0')}:${(h[2]||'00').padStart(2,'0')}`
    }
    if (!parsed.data) {
      const hoje = new Date()
      const amanha = new Date(); amanha.setDate(amanha.getDate()+1)
      const diasSem = ['domingo','segunda','terca','quarta','quinta','sexta','sabado']
      const msgNorm = msg.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
      if (/\bhoje\b/.test(msgNorm)) parsed.data = hoje.toISOString().slice(0,10)
      else if (/\bamanha\b/.test(msgNorm)) parsed.data = amanha.toISOString().slice(0,10)
      else {
        const diaIdx = diasSem.findIndex(d => msgNorm.includes(d))
        if (diaIdx >= 0) {
          const alvo = new Date()
          const diff = (diaIdx - alvo.getDay() + 7) % 7 || 7
          alvo.setDate(alvo.getDate() + diff)
          parsed.data = alvo.toISOString().slice(0,10)
        }
      }
    }
    console.log('[extrairTudo]', mensagem.slice(0,40), '->', JSON.stringify(parsed))
    return parsed
  } catch (e) {
    // Fallback puro por palavras-chave quando Gemini falha
    const msg = mensagem.toLowerCase()
    const r = { servico: null, unidade: null, barbeiro: null, data: null, hora: null, periodo: null, fora_escopo: false }
    if (/corte.{0,15}barba|barba.{0,15}corte/.test(msg)) r.servico = 'corte_barba'
    else if (/infant|crian|filho|filha|bebe|bebê|menin/.test(msg)) r.servico = 'infantil'
    else if (/\bbarba\b|\bbigode\b/.test(msg)) r.servico = 'barba'
    else if (/cort|cabel|aparar|tesoura/.test(msg)) r.servico = 'corte'
    if (/timba/.test(msg)) r.unidade = 'timbauva'
    else if (/\bcentro\b/.test(msg)) r.unidade = 'centro'
    else if (/joao|joão|boark/.test(msg)) r.unidade = 'sao_joao'
    if (/manh/.test(msg)) r.periodo = 'manha'
    else if (/tarde/.test(msg)) r.periodo = 'tarde'
    else if (/noite/.test(msg)) r.periodo = 'noite'
    const h = msg.match(/(\d{1,2})\s*[h:](\d{0,2})/)
    if (h) r.hora = `${h[1].padStart(2,'0')}:${(h[2]||'00').padStart(2,'0')}`
    console.log('[extrairTudo fallback]', mensagem.slice(0,40), '->', JSON.stringify(r))
    return r
  }
}

// ============================================================
// Extrai intenção com Gemini — retorna JSON, nunca texto livre
// ============================================================
async function extrair(mensagem, tipo, dadosAtuais) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_KEY) return {}

  const prompts = {
    servico: `Extraia o serviço que o cliente quer da mensagem abaixo.
Responda APENAS com JSON, sem explicação.
Serviços válidos: "corte", "corte_barba", "barba", "infantil"
Se não for sobre agendamento/serviço de barbearia: {"fora_escopo": true}
Se não entendeu: {}
Mensagem: "${mensagem}"
JSON:`,

    unidade: `Extraia a unidade preferida da mensagem. Unidades: timbaúva, centro, sao_joao.
Responda APENAS com JSON: {"unidade": "timbaúva"} ou {"unidade": "centro"} ou {"unidade": "sao_joao"} ou {}
Mensagem: "${mensagem}"
JSON:`,

    barbeiro: `Extraia a preferência de barbeiro. Se o cliente não tiver preferência, "sem_preferencia".
Responda APENAS com JSON: {"barbeiro": "William"} ou {"barbeiro": "sem_preferencia"} ou {}
Mensagem: "${mensagem}"
JSON:`,

    data: `Extraia data e horário da mensagem. Hoje é ${new Date().toLocaleDateString('pt-BR')}.
Responda APENAS com JSON com campos opcionais:
- "data": "YYYY-MM-DD" (ou null)
- "hora": "HH:MM" (ou null)  
- "periodo": "manha", "tarde" ou "noite" (ou null)
Mensagem: "${mensagem}"
JSON:`,

    numero: `O cliente está escolhendo um número de opção. Qual número escolheu?
Responda APENAS com JSON: {"numero_escolhido": 1} (use o número que aparece na mensagem)
Mensagem: "${mensagem}"
JSON:`,

    confirmacao: `O cliente confirmou ou cancelou? Responda APENAS com JSON:
{"confirmou": true} se disse sim/confirmo/pode ser/ok
{"confirmou": false} se disse não/cancela/desistir
{} se não ficou claro
Mensagem: "${mensagem}"
JSON:`
  }

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompts[tipo] || prompts.servico }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 100 }
        })
      }
    )
    const gdata = await resp.json()
    let raw = gdata?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}'
    raw = raw.replace(/```json|```/g, '').trim()
    return JSON.parse(raw)
  } catch (e) {
    console.error('[whatsapp/extrair]', e.message)
    return {}
  }
}



// ============================================================
// Busca slots disponíveis
// ============================================================
async function buscarSlots(dados) {
  try {
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
    const duracaoMin = dados.servico_duracao || 30

    // Determina data base (em horário de Brasília)
    const agora   = new Date()
    const agoraBR = new Date(agora.getTime() - 3 * 60 * 60 * 1000)
    let dataBase  = new Date(agoraBR.toISOString().slice(0,10) + 'T00:00:00')
    if (dados.data_raw) {
      const d = new Date(dados.data_raw + 'T12:00:00')
      if (!isNaN(d)) dataBase = d
    } else if (!dados.periodo) {
      dataBase.setDate(dataBase.getDate() + 1)
    }

    const diaSemana = dataBase.getDay()  // 0=Dom, 6=Sáb
    if (diaSemana === 0) return []       // Domingo fechado

    // Horário de funcionamento
    const inicioDia = diaSemana === 6 ? 9 * 60 : 10 * 60  // Sáb 9h, Seg-Sex 10h
    const fimDia    = diaSemana === 6 ? 18 * 60 : 20 * 60  // Sáb 18h, Seg-Sex 20h
    const passo     = duracaoMin

    // Gera todos os horários possíveis do dia
    const todosHorarios = []
    for (let t = inicioDia; t + duracaoMin <= fimDia; t += passo) {
      todosHorarios.push(`${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`)
    }

    // Filtra por período se pedido
    let horariosBase = todosHorarios
    if (!dados.hora_raw) {
      if (dados.periodo === 'manha') horariosBase = todosHorarios.filter(h => h < '12:00')
      else if (dados.periodo === 'tarde') horariosBase = todosHorarios.filter(h => h >= '12:00' && h < '18:00')
      else if (dados.periodo === 'noite') horariosBase = todosHorarios.filter(h => h >= '18:00')
    }

    // Se hoje, remove horários que já passaram (+ 15 min de margem)
    const dataStr = dataBase.toISOString().slice(0,10)
    const ehHoje  = dataStr === agoraBR.toISOString().slice(0,10)
    if (ehHoje) {
      const margem = agoraBR.getUTCHours() * 60 + agoraBR.getUTCMinutes() + 15
      const margStr = `${String(Math.floor(margem/60)).padStart(2,'0')}:${String(margem%60).padStart(2,'0')}`
      horariosBase = horariosBase.filter(h => h >= margStr)
      if (horariosBase.length === 0) {
        dados._sem_horario_hoje = true
        // Busca para amanhã
        const amanha = new Date(dataBase)
        amanha.setDate(amanha.getDate() + 1)
        return await buscarSlots({ ...dados, data_raw: amanha.toISOString().slice(0,10), hora_raw: null, _sem_horario_hoje: undefined })
      }
    }

    // Busca colaboradores disponíveis
    let colQuery = supabaseAdmin.from('colaboradores').select('id, nome').eq('ativo', true).neq('perfil', 'caixa')
    if (dados.unidade_id)  colQuery = colQuery.eq('unidade_id', dados.unidade_id)
    if (dados.barbeiro_id) colQuery = colQuery.eq('id', dados.barbeiro_id)
    const { data: cols } = await colQuery
    if (!cols || cols.length === 0) return []

    // Função: slots livres de um colaborador num dia — USA A FONTE CANÔNICA
    // (mesma do app: agendamentos + bloqueios + importados + feriados + funcionamento + 15 min).
    // Antes olhava só 'agendamentos' e ignorava bloqueios/importados → marcava por cima.
    async function slotsLivresDia(col, dStr) {
      let canon = []
      try { canon = await slotsDisponiveis(col.id, dStr, duracaoMin) || [] }
      catch (e) { console.error('[slotsLivresDia canon]', e.message); canon = [] }

      const dObj = new Date(dStr + 'T12:00:00')
      const fmt  = `${diasSemana[dObj.getDay()]} ${String(dObj.getDate()).padStart(2,'0')}/${String(dObj.getMonth()+1).padStart(2,'0')}`

      // só os livres de verdade E que caem na faixa/período pedido (horariosBase)
      return canon
        .filter(s => s.disponivel && horariosBase.includes(s.hora))
        .map(s => ({
          colaborador_id: col.id,
          barbeiro_nome:  col.nome,
          data_iso:       dStr,
          hora_iso:       s.hora,
          data_fmt:       fmt,
          hora_fmt:       s.hora,
          label:          `${s.hora} — ${col.nome} (${fmt})`
        }))
    }

    // Coleta slots
    // SEM PREFERÊNCIA (nenhum barbeiro_id + vários na unidade) → escolhe o com MAIS
    // horários livres no DIA TODO. Depois mostra os slots dele (respeitando a faixa).
    let col = cols[0]
    if (!dados.barbeiro_id && cols.length > 1) {
      let melhorQtd = -1
      for (const c of cols) {
        let canon = []
        try { canon = await slotsDisponiveis(c.id, dataStr, duracaoMin) || [] } catch (e) {}
        const qtd = canon.filter(s => s.disponivel).length
        if (qtd > melhorQtd) { melhorQtd = qtd; col = c }
      }
      dados.barbeiro_id = col.id; dados.barbeiro_nome = col.nome
    }
    const slots = await slotsLivresDia(col, dataStr)

    // Se tem hora específica — ordena por proximidade
    if (dados.hora_raw && slots.length > 0) {
      const exato = slots.find(s => s.hora_iso === dados.hora_raw)
      if (exato) return [exato, ...slots.filter(s => s.hora_iso > dados.hora_raw).slice(0,2)]
      const prox = slots.filter(s => s.hora_iso > dados.hora_raw).slice(0,2)
      const ante = slots.filter(s => s.hora_iso < dados.hora_raw).reverse().slice(0,1)
      // Mesmo horário dia seguinte
      const dia2 = new Date(dataBase); dia2.setDate(dia2.getDate()+1)
      const slots2 = await slotsLivresDia(col, dia2.toISOString().slice(0,10))
      const exato2 = slots2.find(s => s.hora_iso === dados.hora_raw) || slots2.find(s => s.hora_iso >= dados.hora_raw)
      return [...prox, ...ante, ...(exato2 ? [exato2] : [])].slice(0,3)
    }

    return slots.slice(0,6)
  } catch(e) {
    console.error('[buscarSlots]', e.message)
    return []
  }
}

// Busca outros barbeiros no mesmo horário pedido
async function buscarOutrosBarbeirosNoHorario(dados) {
  try {
    if (!dados.hora_raw || !dados.data_raw) return []
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

    let colQuery = supabaseAdmin.from('colaboradores').select('id, nome').eq('ativo', true).neq('perfil', 'caixa')
    if (dados.unidade_id) colQuery = colQuery.eq('unidade_id', dados.unidade_id)
    // Exclui o barbeiro atual
    if (dados.barbeiro_id) colQuery = colQuery.neq('id', dados.barbeiro_id)
    const { data: cols } = await colQuery
    if (!cols || cols.length === 0) return []

    const dataStr = dados.data_raw
    const { data: agds } = await supabaseAdmin.from('agendamentos')
      .select('colaborador_id')
      .in('colaborador_id', cols.map(c => c.id))
      .eq('data_hora', `${dataStr}T${dados.hora_raw}:00`)
      .in('status', ['agendado','confirmado','andamento','concluido','bloqueado'])
    const ocupSet = new Set((agds||[]).map(a => a.colaborador_id))

    const data = new Date(dataStr + 'T12:00:00')
    const fmt  = `${diasSemana[data.getDay()]} ${String(data.getDate()).padStart(2,'0')}/${String(data.getMonth()+1).padStart(2,'0')}`

    return cols
      .filter(c => !ocupSet.has(c.id))
      .map(c => ({
        colaborador_id: c.id,
        barbeiro_nome:  c.nome,
        data_iso:       dataStr,
        hora_iso:       dados.hora_raw,
        data_fmt:       fmt,
        hora_fmt:       dados.hora_raw,
        label:          `${dados.hora_raw} — ${c.nome} (${fmt})`
      }))
      .slice(0,3)
  } catch(e) {
    console.error('[whatsapp/outrosBarbeiros]', e.message)
    return []
  }
}

// ============================================================
// Faz o agendamento no banco
// ============================================================
// ============================================================
// Cria ou localiza cliente para quem agendou pelo WhatsApp
// ============================================================
async function garantirCadastroCliente(conversa, dados) {
  // Já tem cliente vinculado
  if (conversa.cliente_id) return conversa.cliente_id

  const nome   = dados._nome || conversa.nome_contato || 'Cliente WhatsApp'
  const numero = conversa.numero?.replace(/\D/g, '') || ''
  const senha  = '123456'
  const hash   = bcrypt.hashSync(senha, 10)

  // Verifica se já existe pelo número
  const { data: existente } = await supabaseAdmin.from('clientes')
    .select('id').ilike('whatsapp', `%${numero.slice(-9)}%`).eq('ativo', true).limit(1).maybeSingle()

  if (existente) {
    await supabaseAdmin.from('whatsapp_conversas').update({ cliente_id: existente.id }).eq('id', conversa.id)
    return existente.id
  }

  // Cria novo cadastro
  const { data: novo } = await supabaseAdmin.from('clientes').insert({
    nome:        nome.trim(),
    whatsapp:    numero,
    senha_hash:  hash,
    origem:      'whatsapp',
    ativo:       true
  }).select('id').single()

  if (novo) {
    await supabaseAdmin.from('whatsapp_conversas').update({ cliente_id: novo.id }).eq('id', conversa.id)
    dados._cliente_novo = true
    dados._cliente_id   = novo.id
    return novo.id
  }
  return null
}

// Gera token de acesso direto ao app (30 dias)
function gerarTokenApp(clienteId, nome) {
  const secret = process.env.JWT_SECRET
  if (!secret) return null
  return jwt.sign({ id: clienteId, tipo: 'cliente', nome }, secret, { expiresIn: '30d' })
}

async function fazerAgendamento(conversa, dados) {
  try {
    const slot = dados._slot
    if (!slot)              return { ok: false, erro: 'slot não encontrado' }
    if (!dados.servico_id)  return { ok: false, erro: 'serviço não definido' }
    if (!dados.unidade_id)  return { ok: false, erro: 'unidade não definida' }

    // Garante cadastro do cliente
    const clienteId = await garantirCadastroCliente(conversa, dados)

    // Calcula início e fim do agendamento (horário de Brasília UTC-3)
    const duracaoMin = dados.servico_duracao || 30
    const ini = new Date(`${slot.data_iso}T${slot.hora_iso}:00-03:00`)
    const fim = new Date(ini.getTime() + duracaoMin * 60 * 1000)

    const agendamento = {
      colaborador_id: slot.colaborador_id,
      servico_id:     dados.servico_id,
      unidade_id:     dados.unidade_id,
      cliente_id:     clienteId || null,
      cliente_nome:   dados._nome || conversa.nome_contato || null,
      data_hora_ini:  ini.toISOString(),
      data_hora_fim:  fim.toISOString(),
      status:         'agendado',
      valor:          dados.servico_valor || 0,
      canal_origem:   'whatsapp',
      observacao:     `Agendado via WhatsApp — ${conversa.nome_contato || conversa.numero}`
    }

    // Verifica se o slot ainda está disponível (previne dupla marcação).
    // Checa SOBREPOSIÇÃO de intervalo com tudo do dia (agendado/bloqueado/etc),
    // não só igualdade do horário de início — cobre bloqueios e serviços longos.
    const { data: doDia } = await supabaseAdmin.from('agendamentos')
      .select('data_hora_ini, data_hora_fim')
      .eq('colaborador_id', slot.colaborador_id)
      .gte('data_hora_ini', slot.data_iso + 'T00:00:00')
      .lte('data_hora_ini', slot.data_iso + 'T23:59:59')
      .in('status', ['agendado','confirmado','andamento','concluido','bloqueado'])
    const temConflito = (doDia||[]).some(a => {
      const aIni = new Date(a.data_hora_ini).getTime()
      const aFim = a.data_hora_fim ? new Date(a.data_hora_fim).getTime() : aIni + 30 * 60 * 1000
      return ini.getTime() < aFim && fim.getTime() > aIni
    })
    if (temConflito) return { ok: false, erro: 'Este horário acabou de ser ocupado 😔 Precisa escolher outro.' }

    console.log('[fazerAgendamento] inserindo:', JSON.stringify(agendamento))
    const { data: ag, error } = await supabaseAdmin.from('agendamentos').insert(agendamento).select('id').single()
    if (error) {
      console.error('[fazerAgendamento] erro:', error.message, '|', error.details, '|', error.hint)
      return { ok: false, erro: error.message + (error.details ? ' | ' + error.details : '') }
    }

    await supabaseAdmin.from('whatsapp_conversas').update({ agendamento_id: ag.id }).eq('id', conversa.id)
    return { ok: true }
  } catch (e) {
    console.error('[fazerAgendamento] exceção:', e.message)
    return { ok: false, erro: e.message }
  }
}

// ============================================================
// Escalona para atendente humano
// ============================================================
async function escalarHumano(conversa, msg) {
  if (msg) await enviar(conversa, msg)
  await supabaseAdmin.from('whatsapp_conversas').update({
    requer_humano:    true,
    requer_humano_em: new Date().toISOString(),
    estado_ia:        'escalado'
  }).eq('id', conversa.id)
}

// ============================================================
// Controla erros consecutivos → escala após 2 tentativas
// ============================================================
async function erroOuEscalar(conversa, dados, msg) {
  const erros = (dados._erros || 0) + 1
  dados._erros = erros
  if (erros >= 2) {
    await escalarHumano(conversa, MSG.nao_entendeu2)
  } else {
    await supabaseAdmin.from('whatsapp_conversas').update({ dados_ia: dados }).eq('id', conversa.id)
    await enviar(conversa, msg)
  }
}

// ============================================================
// Atualiza estado e dados
// ============================================================

// ============================================================
// Envia mensagem via Evolution
// ============================================================
async function enviar(conversa, texto, remetente = 'ia') {
  const EVOLUTION_URL = process.env.EVOLUTION_API_URL
  const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
  const INSTANCIA     = process.env.EVOLUTION_INSTANCIA || 'barbearia1989'

  try {
    const resp = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCIA}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({ number: conversa.numero, text: texto, options: { delay: 1500 } })
    })
    const result = await resp.json()

    await supabaseAdmin.from('whatsapp_mensagens').upsert({
      conversa_id:      conversa.id,
      evolution_msg_id: result.key?.id || null,
      direcao:          'saida',
      tipo:             'texto',
      conteudo:         texto,
      remetente
    }, { onConflict: 'evolution_msg_id', ignoreDuplicates: true })

    await supabaseAdmin.from('whatsapp_conversas')
      .update({ ultima_msg_em: new Date().toISOString() })
      .eq('id', conversa.id)
  } catch (e) {
    console.error('[whatsapp/enviar]', e.message)
  }
}

// ============================================================
// Envia UMA imagem (foto do barbeiro) com legenda, via Evolution.
// Obs.: o formato do payload de mídia varia por versão da Evolution — este é o
// padrão v2 (mediatype/media/caption). Se a foto não chegar no teste, é aqui que se ajusta.
// ============================================================
async function enviarImagem(conversa, urlImagem, legenda = '') {
  const EVOLUTION_URL = process.env.EVOLUTION_API_URL
  const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
  const INSTANCIA     = process.env.EVOLUTION_INSTANCIA || 'barbearia1989'
  if (!urlImagem) { if (legenda) await enviar(conversa, legenda); return }
  try {
    await fetch(`${EVOLUTION_URL}/message/sendMedia/${INSTANCIA}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({ number: conversa.numero, mediatype: 'image', media: urlImagem, caption: legenda, options: { delay: 900 } })
    })
    await supabaseAdmin.from('whatsapp_conversas')
      .update({ ultima_msg_em: new Date().toISOString() }).eq('id', conversa.id)
  } catch (e) {
    console.error('[whatsapp/enviarImagem]', e.message)
    if (legenda) { try { await enviar(conversa, legenda) } catch (_e) {} }   // fallback: manda só o texto
  }
}

// Fotos-painel (carrossel achatado) de cada unidade — pra opção "não lembro quem me atende".
const PAINEL_UNIDADE = {
  'timbaúva': 'https://pub-d8c17953a575480084b80982d84262c2.r2.dev/timbauva.webp',
  'timbauva': 'https://pub-d8c17953a575480084b80982d84262c2.r2.dev/timbauva.webp',
  'centro':   'https://pub-d8c17953a575480084b80982d84262c2.r2.dev/centro.webp',
  'são joão': 'https://pub-d8c17953a575480084b80982d84262c2.r2.dev/sao_joao.webp',
  'sao joao': 'https://pub-d8c17953a575480084b80982d84262c2.r2.dev/sao_joao.webp',
  'sao_joao': 'https://pub-d8c17953a575480084b80982d84262c2.r2.dev/sao_joao.webp',
}
function painelDaUnidade(nomeUnidade) {
  return PAINEL_UNIDADE[String(nomeUnidade || '').toLowerCase().trim()] || null
}

// ============================================================
// Envia uma LISTA INTERATIVA (sendList). Formato da doc da Evolution:
// { number, title, description, buttonText, sections:[{ title, rows:[{ title, description, rowId }] }] }
// Fallback embutido: se a lista não renderizar no aparelho, o WhatsApp mostra o texto,
// e o cliente pode responder o NÚMERO (as fases também aceitam número/rowId).
// ============================================================
async function enviarLista(conversa, { title, description, buttonText, rows, remetente = 'ia' }) {
  const EVOLUTION_URL = process.env.EVOLUTION_API_URL
  const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
  const INSTANCIA     = process.env.EVOLUTION_INSTANCIA || 'barbearia1989'
  try {
    const resp = await fetch(`${EVOLUTION_URL}/message/sendList/${INSTANCIA}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({
        number: conversa.numero,
        title:  title || '',
        description: description || '',
        buttonText:  buttonText || 'Ver opções',
        sections: [{ title: title || ' ', rows: (rows || []).map(r => ({ title: r.title, description: r.description || '', rowId: String(r.rowId) })) }]
      })
    })
    const result = await resp.json().catch(() => ({}))
    await supabaseAdmin.from('whatsapp_mensagens').upsert({
      conversa_id: conversa.id, evolution_msg_id: result.key?.id || null,
      direcao: 'saida', tipo: 'lista',
      conteudo: (title ? title + '\n' : '') + (rows || []).map((r, i) => `${i + 1}. ${r.title}`).join('\n'),
      remetente
    }, { onConflict: 'evolution_msg_id', ignoreDuplicates: true })
    await supabaseAdmin.from('whatsapp_conversas').update({ ultima_msg_em: new Date().toISOString() }).eq('id', conversa.id)
  } catch (e) {
    console.error('[whatsapp/enviarLista]', e.message)
    // fallback total em texto numerado
    const txt = (description ? description + '\n\n' : '') + (rows || []).map((r, i) => `${i + 1}. ${r.title}`).join('\n')
    try { await enviar(conversa, txt) } catch (_e) {}
  }
}

// ============================================================
// Helpers de nome
// ============================================================
function nomearServico(raw) {
  const map = { corte: 'Corte de cabelo', corte_barba: 'Corte + Barba', barba: 'Barba', infantil: 'Corte infantil' }
  return map[raw] || raw
}
function nomearUnidade(raw) {
  const map = { 'timbaúva': 'Timbaúva', 'timbauva': 'Timbaúva', centro: 'Centro', sao_joao: 'São João', 'são joão': 'São João', 'buarque': 'São João', 'barbearia da buarque': 'São João' }
  return map[raw?.toLowerCase()] || raw
}

// ============================================================
// GET /whatsapp/conversas
// ============================================================
router.get('/conversas', async (req, res) => {
  try {
    const { status = 'aberta' } = req.query
    const { data } = await supabaseAdmin
      .from('whatsapp_conversas')
      .select('id, numero, nome_contato, status, atendente, estado_ia, requer_humano, ultima_msg_em, cliente_id, dados_ia, cliente:clientes(id, nome, whatsapp, user_id)')
      .eq('status', status)
      .order('requer_humano', { ascending: false })
      .order('ultima_msg_em', { ascending: false })
      .limit(50)
    res.json(data || [])
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

// ============================================================
// GET /whatsapp/conversas/:id/contexto
// ============================================================
router.get('/conversas/:id/contexto', async (req, res) => {
  try {
    const { data: conv } = await supabaseAdmin.from('whatsapp_conversas')
      .select('cliente_id, numero, nome_contato, estado_ia, dados_ia, requer_humano')
      .eq('id', req.params.id).single()
    if (!conv) return res.status(404).json({ erro: 'Não encontrada' })
    if (!conv.cliente_id) return res.json({ identificado: false, numero: conv.numero, nome: conv.nome_contato })
    const ctx = await buscarContextoCliente(conv.cliente_id)
    res.json({ identificado: true, ...ctx })
  } catch (e) {
    res.status(500).json({ erro: e.message })
  }
})

async function buscarContextoCliente(clienteId) {
  try {
    const [{ data: cli }, { data: ultimoAg }, { data: plano }, { data: carteira }] = await Promise.all([
      supabaseAdmin.from('clientes').select('nome, email, user_id').eq('id', clienteId).single(),
      supabaseAdmin.from('agendamentos').select('unidades(id,nome), colaboradores(id,nome), servicos(nome), data_hora').eq('cliente_id', clienteId).eq('status', 'realizado').order('data_hora', { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin.from('assinaturas').select('planos(nome), data_renovacao').eq('cliente_id', clienteId).eq('status', 'ativa').limit(1).maybeSingle(),
      supabaseAdmin.from('carteira_pontos').select('saldo').eq('cliente_id', clienteId).maybeSingle()
    ])
    return {
      nome: cli?.nome, email: cli?.email, tem_app: !!cli?.user_id,
      ultima_unidade: ultimoAg?.unidades?.nome || null,
      ultima_unidade_id: ultimoAg?.unidades?.id || null,
      ultimo_barbeiro: ultimoAg?.colaboradores?.nome || null,
      ultimo_barbeiro_id: ultimoAg?.colaboradores?.id || null,
      ultimo_servico: ultimoAg?.servicos?.nome || null,
      plano_ativo: plano?.planos?.nome || null,
      plano_vence: plano?.data_renovacao || null,
      pontos: carteira?.saldo || 0
    }
  } catch (e) { return null }
}

// ============================================================
// GET /whatsapp/conversas/:id/mensagens
// ============================================================
router.get('/conversas/:id/mensagens', async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('whatsapp_mensagens')
      .select('id, direcao, tipo, conteudo, remetente, criado_em')
      .eq('conversa_id', req.params.id)
      .order('criado_em', { ascending: true }).limit(100)
    res.json(data || [])
  } catch (e) { res.status(500).json({ erro: e.message }) }
})

// ============================================================
// POST /whatsapp/conversas/:id/enviar (humano)
// ============================================================
router.post('/conversas/:id/enviar', async (req, res) => {
  try {
    const { texto, remetente = 'humano' } = req.body || {}
    if (!texto) return res.status(400).json({ erro: 'Informe o texto' })
    const { data: conv } = await supabaseAdmin.from('whatsapp_conversas').select('numero').eq('id', req.params.id).single()
    if (!conv) return res.status(404).json({ erro: 'Não encontrada' })
    await enviar(conv, texto, remetente)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ erro: e.message }) }
})

// ============================================================
// PATCH /whatsapp/conversas/:id
// ============================================================
router.patch('/conversas/:id', async (req, res) => {
  try {
    const { status, atendente, requer_humano } = req.body || {}
    const upd = {}
    if (status !== undefined)        upd.status        = status
    if (atendente !== undefined)     upd.atendente     = atendente
    if (requer_humano !== undefined) upd.requer_humano = requer_humano
    if (atendente === 'ia')          upd.requer_humano = false
    await supabaseAdmin.from('whatsapp_conversas').update(upd).eq('id', req.params.id)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ erro: e.message }) }
})

// ============================================================
// POST /whatsapp/conversas/:id/acionar-ia
// Força a IA processar a última mensagem do cliente
// ============================================================
router.post('/conversas/:id/acionar-ia', async (req, res) => {
  try {
    const { data: conv } = await supabaseAdmin
      .from('whatsapp_conversas')
      .select('*')
      .eq('id', req.params.id)
      .single()
    if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada' })

    // Busca TODAS as mensagens do cliente em ordem cronológica
    const { data: msgs } = await supabaseAdmin
      .from('whatsapp_mensagens')
      .select('conteudo, tipo')
      .eq('conversa_id', req.params.id)
      .eq('direcao', 'entrada')
      .eq('tipo', 'texto')
      .order('criado_em', { ascending: true })

    // Concatena ignorando mensagens muito curtas (?, ok, oi)
    const textoCliente = (msgs || [])
      .map(m => (m.conteudo || '').trim())
      .filter(c => c.length > 3)
      .join(' ')

    if (!textoCliente) {
      return res.status(400).json({ erro: 'Nenhuma mensagem com conteúdo suficiente' })
    }

    // Reinicia estado para inicial e garante modo IA
    await supabaseAdmin.from('whatsapp_conversas')
      .update({ atendente: 'ia', requer_humano: false, estado_ia: 'inicial', dados_ia: {} })
      .eq('id', req.params.id)
    conv.atendente     = 'ia'
    conv.requer_humano = false
    conv.estado_ia     = 'inicial'
    conv.dados_ia      = {}

    res.json({ ok: true, mensagem: textoCliente })

    // Processa com o contexto completo da conversa
    await processarFluxo(conv, textoCliente)
  } catch (e) {
    console.error('[whatsapp/acionar-ia]', e.message)
    res.status(500).json({ erro: e.message })
  }
})

// ============================================================
// POST /whatsapp/notificar-fechamento
// Envia resumo do dia para o proprietário quando o caixa fecha
// ============================================================
router.post('/notificar-fechamento', async (req, res) => {
  res.json({ ok: true }) // responde imediatamente
  try {
    const { unidade_id, data } = req.body
    const hoje = data || new Date().toISOString().slice(0,10)

    // Busca nome da unidade
    const { data: uni } = await supabaseAdmin.from('unidades')
      .select('nome').eq('id', unidade_id).single()
    const nomeUnidade = uni?.nome || 'Unidade'

    // Busca métricas do dia para a unidade
    const { data: ags } = await supabaseAdmin.from('agendamentos')
      .select('valor, status')
      .eq('unidade_id', unidade_id)
      .gte('data_hora_ini', hoje + 'T00:00:00')
      .lte('data_hora_ini', hoje + 'T23:59:59')
      .in('status', ['concluido', 'realizado'])

    const finalizados = (ags || []).length
    const faturamento = (ags || []).reduce((s, a) => s + Number(a.valor || 0), 0)
    const ticket = finalizados > 0 ? faturamento / finalizados : 0

    const msg = `🔒 *Caixa ${nomeUnidade} Fechado!*

`
      + `💰 Faturamento: *R$ ${faturamento.toFixed(2).replace('.', ',')}*
`
      + `✂️ Agendamentos finalizados: *${finalizados}*
`
      + `🎯 Ticket médio: *R$ ${ticket.toFixed(2).replace('.', ',')}*`

    // Busca o proprietário com WhatsApp cadastrado
    const { data: prop } = await supabaseAdmin.from('colaboradores')
      .select('clientes(whatsapp, nome)')
      .eq('perfil', 'proprietario')
      .eq('ativo', true)
      .limit(1)
      .maybeSingle()

    // Tenta via clientes vinculados ao perfil proprietário
    let whatsappProprietario = null
    if (prop?.clientes?.whatsapp) {
      whatsappProprietario = prop.clientes.whatsapp.replace(/\D/g, '')
    } else {
      // Busca direto em colaboradores por perfil proprietário
      const { data: cols } = await supabaseAdmin.from('colaboradores')
        .select('whatsapp').eq('perfil', 'proprietario').eq('ativo', true)
      if (cols && cols.length > 0 && cols[0].whatsapp) {
        whatsappProprietario = cols[0].whatsapp.replace(/\D/g, '')
      }
    }

    if (whatsappProprietario) {
      const EVOLUTION_URL    = process.env.EVOLUTION_API_URL
      const EVOLUTION_KEY    = process.env.EVOLUTION_API_KEY
      const EVOLUTION_INST   = process.env.EVOLUTION_INSTANCIA
      await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INST}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
        body: JSON.stringify({ number: whatsappProprietario, text: msg })
      })
      console.log(`[fechamento] Notificação enviada para ${whatsappProprietario}`)
    } else {
      console.log('[fechamento] Proprietário sem WhatsApp cadastrado')
    }
  } catch (e) {
    console.error('[fechamento] erro:', e.message)
  }
})

// ============================================================
// GET /whatsapp/alertas
// ============================================================
router.get('/alertas', async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('whatsapp_conversas')
      .select('id, nome_contato, numero, requer_humano_em')
      .eq('requer_humano', true).eq('status', 'aberta')
      .order('requer_humano_em', { ascending: false })
    res.json(data || [])
  } catch (e) { res.status(500).json({ erro: e.message }) }
})

module.exports = router
