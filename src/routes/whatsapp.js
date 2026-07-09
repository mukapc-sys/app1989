// ============================================================
// routes/whatsapp.js — Atendimento WhatsApp com IA roteirizada
// A IA só extrai intenções. Todas as respostas são pré-configuradas.
// ============================================================
const express           = require('express')
const router            = express.Router()
const { supabaseAdmin } = require('../config/supabase')

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
// POST /whatsapp/webhook
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
      const ext = await extrairTudo(mensagemCliente)
      if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }
      if (!ext.servico) { await erroOuEscalar(conversa, dados, MSG.nao_entendeu); return }
      dados.servico_raw  = ext.servico
      dados.servico_nome = nomearServico(ext.servico)
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
        const colQ = supabaseAdmin.from('colaboradores').select('id,nome').eq('ativo', true).ilike('nome', `%${nomeBarbeiro}%`).limit(1)
        if (dados.unidade_id) colQ.eq('unidade_id', dados.unidade_id)
        const { data: col } = await colQ.maybeSingle()
        if (col) {
          dados.barbeiro_id   = col.id
          dados.barbeiro_nome = col.nome
        } else {
          // Busca em outras unidades
          const { data: colOutra } = await supabaseAdmin.from('colaboradores')
            .select('id,nome,unidades(nome)').eq('ativo', true).ilike('nome', `%${nomeBarbeiro}%`).limit(1).maybeSingle()
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
            .select('id,nome').eq('ativo', true).eq('unidade_id', dados.unidade_id).neq('id', dados.barbeiro_id)
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
        const ok = await fazerAgendamento(conversa, dados)
        if (ok) {
          await enviar(conversa, MSG.agendado(dados))
          await setFase(conversa.id, 'fase4_concluido', dados)
        } else {
          await escalarHumano(conversa, `Tive um problema ao confirmar 😔 Vou chamar um atendente!`)
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
    console.error('[fluxo] erro:', e.message)
    await escalarHumano(conversa, `Tive um problema técnico 😔 Vou chamar um atendente!`)
  }
}

// ── Lógica de avanço da Fase 2 (verifica o que já tem e pula etapas) ──
async function irParaFase2(conversa, dados) {
  const nome = dados._nome || null

  // Resolve unidade_id se ainda não tem
  if (dados.unidade_raw && !dados.unidade_id) {
    const { data: uni } = await supabaseAdmin.from('unidades').select('id').ilike('nome', `%${dados.unidade_nome}%`).limit(1).maybeSingle()
    if (uni) dados.unidade_id = uni.id
  }
  // Resolve barbeiro_id se tem nome mas não tem id
  if (dados.barbeiro_raw && !dados.barbeiro_id && dados.barbeiro_raw !== 'historico') {
    const colQ = supabaseAdmin.from('colaboradores').select('id,nome').eq('ativo', true).ilike('nome', `%${dados.barbeiro_raw}%`).limit(1)
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
  if (dados.barbeiro_id === undefined && !dados.barbeiro_raw) {
    await responder(conversa, 'pede_barbeiro', { ...ctx, unidade: dados.unidade_nome }, MSG.pede_barbeiro(nome))
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
- São João, sao joao, boark → "sao_joao"
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
// Busca slots disponíveis — ordenados por proximidade ao pedido
// ============================================================
async function buscarSlots(dados) {
  try {
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

    // Horários padrão da barbearia (09:00-19:00, a cada 30min)
    const todosHorarios = []
    for (let h = 9; h <= 18; h++) {
      todosHorarios.push(`${String(h).padStart(2,'0')}:00`)
      todosHorarios.push(`${String(h).padStart(2,'0')}:30`)
    }
    todosHorarios.push('19:00')

    // Filtra por período se não tem hora exata
    let horariosBase = todosHorarios
    if (!dados.hora_raw) {
      if (dados.periodo === 'manha') horariosBase = todosHorarios.filter(h => h < '12:00')
      else if (dados.periodo === 'tarde') horariosBase = todosHorarios.filter(h => h >= '12:00' && h < '18:00')
      else if (dados.periodo === 'noite') horariosBase = todosHorarios.filter(h => h >= '18:00')
    }

    // Determina data base
    let dataBase = new Date()
    dataBase.setHours(0,0,0,0)
    if (dados.data_raw) {
      const d = new Date(dados.data_raw + 'T12:00:00')
      if (!isNaN(d)) dataBase = d
    } else if (!dados.periodo) {
      dataBase.setDate(dataBase.getDate() + 1) // padrão: amanhã
    }

    // Se a data for HOJE, filtra horários que já passaram (+ 30min de margem)
    const agora = new Date()
    const ehHoje = dataBase.toISOString().slice(0,10) === agora.toISOString().slice(0,10)
    if (ehHoje) {
      const margemMin  = agora.getMinutes() + 30
      const margemH    = agora.getHours() + Math.floor(margemMin / 60)
      const margemStr  = String(margemH).padStart(2,'0') + ':' + String(margemMin % 60).padStart(2,'0')
      horariosBase = horariosBase.filter(h => h >= margemStr)
      // Se não sobrou nada hoje → usa amanhã automaticamente
      if (horariosBase.length === 0) {
        dados._sem_horario_hoje = true  // sinaliza para mostrar aviso ao cliente
        dataBase = new Date()
        dataBase.setDate(dataBase.getDate() + 1)
        dataBase.setHours(0,0,0,0)
        horariosBase = todosHorarios
        if (dados.periodo === 'manha')      horariosBase = todosHorarios.filter(h => h < '12:00')
        else if (dados.periodo === 'tarde') horariosBase = todosHorarios.filter(h => h >= '12:00' && h < '18:00')
        else if (dados.periodo === 'noite') horariosBase = todosHorarios.filter(h => h >= '18:00')
      }
    }

    // Busca colaboradores
    let colQuery = supabaseAdmin.from('colaboradores').select('id, nome').eq('ativo', true)
    if (dados.unidade_id) colQuery = colQuery.eq('unidade_id', dados.unidade_id)
    if (dados.barbeiro_id) colQuery = colQuery.eq('id', dados.barbeiro_id)
    const { data: cols } = await colQuery
    if (!cols || cols.length === 0) return []

    // Se sem preferência → pega o com mais disponibilidade
    let colAlvo = cols
    if (!dados.barbeiro_id && cols.length > 1) {
      // Conta livres para cada barbeiro e pega o melhor
      const { data: agDia } = await supabaseAdmin.from('agendamentos')
        .select('colaborador_id')
        .in('colaborador_id', cols.map(c => c.id))
        .gte('data_hora', dataBase.toISOString().slice(0,10) + 'T00:00:00')
        .lte('data_hora', dataBase.toISOString().slice(0,10) + 'T23:59:59')
        .in('status', ['agendado','confirmado'])
      const ocupCount = {}
      ;(agDia||[]).forEach(a => { ocupCount[a.colaborador_id] = (ocupCount[a.colaborador_id]||0)+1 })
      const sorted = [...cols].sort((a,b) => (ocupCount[a.id]||0) - (ocupCount[b.id]||0))
      colAlvo = [sorted[0]]
    }

    // Função auxiliar: busca slots livres num dia específico para um colaborador
    async function slotsLivresDia(col, data) {
      const dataStr = data.toISOString().slice(0,10)
      const { data: agds } = await supabaseAdmin.from('agendamentos')
        .select('data_hora')
        .eq('colaborador_id', col.id)
        .gte('data_hora', dataStr + 'T00:00:00')
        .lte('data_hora', dataStr + 'T23:59:59')
        .in('status', ['agendado','confirmado'])
      const ocupSet = new Set((agds||[]).map(a => a.data_hora.slice(11,16)))
      const fmt = `${diasSemana[data.getDay()]} ${String(data.getDate()).padStart(2,'0')}/${String(data.getMonth()+1).padStart(2,'0')}`
      return horariosBase
        .filter(h => !ocupSet.has(h))
        .map(h => ({
          colaborador_id: col.id,
          barbeiro_nome:  col.nome,
          data_iso:       dataStr,
          hora_iso:       h,
          data_fmt:       fmt,
          hora_fmt:       h,
          label:          `${h} — ${col.nome} (${fmt})`
        }))
    }

    // MODO 1: Tem hora específica pedida → busca por proximidade
    if (dados.hora_raw) {
      const col = colAlvo[0]
      const slots = []

      // A) Mesma hora, mesmo dia
      const livresDia1 = await slotsLivresDia(col, dataBase)
      const exato = livresDia1.find(s => s.hora_iso === dados.hora_raw)
      if (exato) {
        // Horário exato disponível — retorna ele + próximos como bonus
        slots.push(exato)
        livresDia1.filter(s => s.hora_iso > dados.hora_raw).slice(0,2).forEach(s => slots.push(s))
        return slots.slice(0,3)
      }

      // Exato não disponível — busca PRÓXIMOS com mesma referência
      // B) Mesmo barbeiro, mesmo dia, horários próximos (depois e antes)
      const depoisDia1 = livresDia1.filter(s => s.hora_iso > dados.hora_raw).slice(0,2)
      const antesDia1  = livresDia1.filter(s => s.hora_iso < dados.hora_raw).reverse().slice(0,1)
      depoisDia1.forEach(s => { s._prioridade = 1; slots.push(s) })
      antesDia1.forEach(s  => { s._prioridade = 2; slots.push(s) })

      // C) Mesmo barbeiro, dia seguinte, mesmo horário (ou próximos)
      const dia2 = new Date(dataBase); dia2.setDate(dia2.getDate() + 1)
      const livresDia2 = await slotsLivresDia(col, dia2)
      const exatoDia2  = livresDia2.find(s => s.hora_iso === dados.hora_raw)
      if (exatoDia2) {
        exatoDia2._prioridade = 3
        slots.push(exatoDia2)
      } else {
        const proxDia2 = livresDia2.filter(s => s.hora_iso >= dados.hora_raw).slice(0,1)
        proxDia2.forEach(s => { s._prioridade = 4; slots.push(s) })
      }

      // Ordena: mesmo dia primeiro, depois dia seguinte; dentro do dia: mais próximo à hora pedida
      slots.sort((a,b) => (a._prioridade||9) - (b._prioridade||9))
      return slots.slice(0,3)
    }

    // MODO 2: Sem hora específica → lista os primeiros disponíveis do período
    const slots = []
    for (const col of colAlvo) {
      const livres = await slotsLivresDia(col, dataBase)
      livres.slice(0,6).forEach(s => slots.push(s))
      if (slots.length >= 6) break
    }
    return slots.slice(0,6)

  } catch (e) {
    console.error('[whatsapp/slots]', e.message)
    return []
  }
}

// Busca outros barbeiros no mesmo horário pedido
async function buscarOutrosBarbeirosNoHorario(dados) {
  try {
    if (!dados.hora_raw || !dados.data_raw) return []
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

    let colQuery = supabaseAdmin.from('colaboradores').select('id, nome').eq('ativo', true)
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
      .in('status', ['agendado','confirmado'])
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
async function fazerAgendamento(conversa, dados) {
  try {
    const slot = dados.slot_escolhido
    if (!slot) return false

    // Busca serviço
    const { data: svc } = await supabaseAdmin.from('servicos')
      .select('id').ilike('nome', `%${dados.servico_nome?.split(' ')[0]}%`).limit(1).maybeSingle()

    const agendamento = {
      colaborador_id: slot.colaborador_id,
      servico_id:     svc?.id || null,
      unidade_id:     dados.unidade_id || null,
      cliente_id:     conversa.cliente_id || null,
      data_hora:      `${slot.data_iso}T${slot.hora_iso}:00`,
      status:         'agendado',
      origem:         'whatsapp',
      observacoes:    `Agendado via WhatsApp — ${conversa.nome_contato || conversa.numero}`
    }

    const { data: ag, error } = await supabaseAdmin.from('agendamentos').insert(agendamento).select('id').single()
    if (error) throw error

    // Vincula agendamento à conversa
    await supabaseAdmin.from('whatsapp_conversas')
      .update({ agendamento_id: ag.id })
      .eq('id', conversa.id)

    return true
  } catch (e) {
    console.error('[whatsapp/fazerAgendamento]', e.message)
    return false
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

    await supabaseAdmin.from('whatsapp_mensagens').insert({
      conversa_id:      conversa.id,
      evolution_msg_id: result.key?.id || null,
      direcao:          'saida',
      tipo:             'texto',
      conteudo:         texto,
      remetente
    })

    await supabaseAdmin.from('whatsapp_conversas')
      .update({ ultima_msg_em: new Date().toISOString() })
      .eq('id', conversa.id)
  } catch (e) {
    console.error('[whatsapp/enviar]', e.message)
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
  const map = { 'timbaúva': 'Timbaúva', 'timbauva': 'Timbaúva', centro: 'Centro', sao_joao: 'São João', 'são joão': 'São João' }
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
