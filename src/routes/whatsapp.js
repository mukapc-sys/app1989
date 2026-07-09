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
// MÁQUINA DE ESTADOS — fluxo roteirizado
// ============================================================
async function processarFluxo(conversa, mensagemCliente) {
  const estado  = conversa.estado_ia || 'inicial'
  const dados   = conversa.dados_ia  || {}
  const erros   = dados._erros || 0

  console.log(`[fluxo] estado=${estado} msg=${mensagemCliente?.slice(0,50)}`)

  try {
    // ── ESTADO: inicial → tenta extrair tudo de uma vez antes de pedir etapa por etapa
    if (estado === 'inicial') {
      const tudo = await extrairTudo(mensagemCliente)
      if (tudo.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }

      // Preenche o que já veio na primeira mensagem
      if (tudo.servico)  { dados.servico_raw = tudo.servico;   dados.servico_nome = nomearServico(tudo.servico) }
      if (tudo.unidade)  { dados.unidade_raw = tudo.unidade;   dados.unidade_nome = nomearUnidade(tudo.unidade) }
      if (tudo.barbeiro && tudo.barbeiro !== 'sem_preferencia') dados.barbeiro_raw = tudo.barbeiro
      if (tudo.data)     dados.data_raw  = tudo.data
      if (tudo.hora)     dados.hora_raw  = tudo.hora
      if (tudo.periodo)  dados.periodo   = tudo.periodo

      // Busca unidade_id se unidade foi informada
      if (dados.unidade_raw) {
        const { data: uni } = await supabaseAdmin.from('unidades')
          .select('id,nome').ilike('nome', `%${dados.unidade_nome}%`).limit(1).maybeSingle()
        if (uni) dados.unidade_id = uni.id
      }

      // Busca barbeiro_id se barbeiro foi informado
      if (dados.barbeiro_raw) {
        const q = supabaseAdmin.from('colaboradores').select('id,nome').eq('ativo', true).ilike('nome', `%${dados.barbeiro_raw}%`).limit(1)
        if (dados.unidade_id) q.eq('unidade_id', dados.unidade_id)
        const { data: col } = await q.maybeSingle()
        if (col) { dados.barbeiro_id = col.id; dados.barbeiro_nome = col.nome }
      }

      // Avança direto para o passo que falta
      if (!dados.servico_raw) {
        await enviar(conversa, MSG.boas_vindas)
        await setEstado(conversa.id, 'aguardando_servico', dados)
        return
      }
      if (!dados.unidade_raw) {
        await enviar(conversa, `Olá! 😊 Serviço: *\${dados.servico_nome}*. \${MSG.pede_unidade}`)
        await setEstado(conversa.id, 'aguardando_unidade', dados)
        return
      }
      if (!dados.barbeiro_raw && dados.barbeiro_id === undefined) {
        await enviar(conversa, MSG.pede_barbeiro(dados._nome_cliente))
        await setEstado(conversa.id, 'aguardando_barbeiro', dados)
        return
      }
      if (!dados.data_raw && !dados.hora_raw && !dados.periodo) {
        await enviar(conversa, MSG.pede_data(dados._nome_cliente))
        await setEstado(conversa.id, 'aguardando_data', dados)
        return
      }
      // Tem tudo! Busca slots direto
      const slots = await buscarSlots(dados)
      if (!slots || slots.length === 0) {
        await enviar(conversa, MSG.sem_horarios)
        await setEstado(conversa.id, 'aguardando_data', dados)
      } else {
        dados.slots = slots
        const temHorarioExato = dados.hora_raw && slots.some(s => s.hora_iso === dados.hora_raw)
        const podeBuscarOutro = !temHorarioExato && dados.hora_raw && !!dados.barbeiro_id
        dados._pode_buscar_outro = podeBuscarOutro
        const msgSlots = !temHorarioExato && dados.hora_raw
          ? MSG.horario_indisponivel(slots, podeBuscarOutro)
          : MSG.mostra_horarios(slots)
        await enviar(conversa, msgSlots)
        await setEstado(conversa.id, 'escolhendo_horario', dados)
      }
      return
    }

    // ── ESTADO: aguardando_nome
    if (estado === 'aguardando_nome') {
      const nome = mensagemCliente.trim().split(' ').slice(0,2).join(' ') // pega até 2 palavras
      if (nome && nome.length > 1) {
        dados._nome_cliente = nome
        dados._erros = 0
        await enviar(conversa, MSG.boas_vindas_com_nome(nome))
        await setEstado(conversa.id, 'aguardando_servico', dados)
      } else {
        await erroOuEscalar(conversa, dados, `Não entendi seu nome 😅 Pode me dizer como se chama?`)
      }
      return
    }

    // ── ESTADO: aguardando_servico
    if (estado === 'aguardando_servico') {
      // Tenta extrair tudo (cliente pode ter mandado info completa numa resposta posterior)
      const tudo = await extrairTudo(mensagemCliente)
      if (tudo.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }
      const servico = tudo.servico
      if (servico) {
        dados.servico_raw  = servico
        dados.servico_nome = nomearServico(servico)
        // Aproveita o que mais veio
        if (tudo.unidade)  { dados.unidade_raw = tudo.unidade; dados.unidade_nome = nomearUnidade(tudo.unidade) }
        if (tudo.barbeiro) dados.barbeiro_raw = tudo.barbeiro
        if (tudo.data)     dados.data_raw  = tudo.data
        if (tudo.hora)     dados.hora_raw  = tudo.hora
        if (tudo.periodo)  dados.periodo   = tudo.periodo
        dados._erros = 0
        if (!dados.unidade_raw) {
          await enviar(conversa, MSG.pede_unidade)
          await setEstado(conversa.id, 'aguardando_unidade', dados)
        } else {
          await enviar(conversa, MSG.pede_barbeiro(dados._nome_cliente))
          await setEstado(conversa.id, 'aguardando_barbeiro', dados)
        }
      } else {
        await erroOuEscalar(conversa, dados, MSG.nao_entendeu)
      }
      return
    }

    // ── ESTADO: aguardando_unidade
    if (estado === 'aguardando_unidade') {
      const ext = await extrairTudo(mensagemCliente)
      if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }
      if (ext.unidade) {
        dados.unidade_raw  = ext.unidade
        dados.unidade_nome = nomearUnidade(ext.unidade)
        // Busca unidade_id no banco
        const { data: uni } = await supabaseAdmin.from('unidades')
          .select('id,nome').ilike('nome', `%${dados.unidade_nome}%`).limit(1).maybeSingle()
        if (uni) dados.unidade_id = uni.id
        dados._erros = 0
        await enviar(conversa, MSG.pede_barbeiro(dados._nome_cliente))
        await setEstado(conversa.id, 'aguardando_barbeiro', dados)
      } else {
        await erroOuEscalar(conversa, dados, MSG.nao_entendeu)
      }
      return
    }

    // ── ESTADO: aguardando_barbeiro
    if (estado === 'aguardando_barbeiro') {
      const ext = await extrairTudo(mensagemCliente)
      if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }

      const nomeBarbeiro = ext.barbeiro
      const msg = mensagemCliente.toLowerCase()

      // Cliente diz que TEM preferência mas não falou o nome → pede o nome
      const querBarbeiro = /tenho|quero|prefiro|gosto/.test(msg) && !nomeBarbeiro
      if (querBarbeiro) {
        await enviar(conversa, 'Qual o nome do barbeiro? 😊')
        return
      }

      if (!nomeBarbeiro || nomeBarbeiro === 'sem_preferencia') {
        // Sem preferência ou campo vazio/undefined → mais disponível
        dados.barbeiro_raw  = null
        dados.barbeiro_nome = 'Mais disponível'
        dados.barbeiro_id   = null
      } else {
        // Busca barbeiro por nome na unidade
        const colQuery = supabaseAdmin.from('colaboradores')
          .select('id,nome')
          .eq('ativo', true)
          .ilike('nome', `%${nomeBarbeiro}%`)
          .limit(1)
        if (dados.unidade_id) colQuery.eq('unidade_id', dados.unidade_id)
        const { data: col } = await colQuery.maybeSingle()
        if (col) {
          dados.barbeiro_id   = col.id
          dados.barbeiro_nome = col.nome
        } else {
          dados.barbeiro_id   = null
          dados.barbeiro_nome = 'Mais disponível'
        }
      }
      dados._erros = 0
      await enviar(conversa, MSG.pede_data(dados._nome_cliente))
      await setEstado(conversa.id, 'aguardando_data', dados)
      return
    }

    // ── ESTADO: aguardando_data
    if (estado === 'aguardando_data') {
      // Primeiro tenta extrair TUDO — cliente pode estar mudando serviço/barbeiro/unidade
      const tudo = await extrairTudo(mensagemCliente)
      if (tudo.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }

      // Detecta mudança de serviço/barbeiro/unidade (cliente não quer repetir o histórico)
      if (tudo.servico && tudo.servico !== dados.servico_raw) {
        dados.servico_raw = tudo.servico; dados.servico_nome = nomearServico(tudo.servico); dados._usando_historico = false
      }
      if (tudo.unidade) {
        dados.unidade_raw = tudo.unidade; dados.unidade_nome = nomearUnidade(tudo.unidade)
        const { data: uni } = await supabaseAdmin.from('unidades').select('id').ilike('nome', `%${dados.unidade_nome}%`).limit(1).maybeSingle()
        if (uni) dados.unidade_id = uni.id
      }
      if (tudo.barbeiro && tudo.barbeiro !== 'sem_preferencia') {
        const { data: col } = await supabaseAdmin.from('colaboradores').select('id,nome').eq('ativo', true).ilike('nome', `%${tudo.barbeiro}%`).limit(1).maybeSingle()
        if (col) { dados.barbeiro_id = col.id; dados.barbeiro_nome = col.nome; dados.barbeiro_raw = col.nome }
      }

      const ext = tudo
      if (ext.fora_escopo) { await escalarHumano(conversa, MSG.fora_escopo); return }
      if (ext.data || ext.hora || ext.periodo) {
        dados.data_raw  = ext.data  || null
        dados.hora_raw  = ext.hora  || null
        dados.periodo   = ext.periodo || null
        dados._erros = 0
        // Busca horários disponíveis
        const slots = await buscarSlots(dados)
        if (!slots || slots.length === 0) {
          // Tenta o dia seguinte automaticamente
          const dataAtual = dados.data_raw ? new Date(dados.data_raw) : new Date()
          dataAtual.setDate(dataAtual.getDate() + 1)
          dados.data_raw = dataAtual.toISOString().slice(0,10)
          const slotsProximo = await buscarSlots(dados)
          if (slotsProximo && slotsProximo.length > 0) {
            dados.slots = slotsProximo
            await enviar(conversa, `Não há horários disponíveis nesse dia 😔 Mas encontrei no dia seguinte:\n\n` + MSG.mostra_horarios(slotsProximo).split('\n').slice(1).join('\n'))
            await setEstado(conversa.id, 'escolhendo_horario', dados)
          } else {
            await enviar(conversa, MSG.sem_horarios)
            await setEstado(conversa.id, 'aguardando_data', { ...dados, data_raw: null, hora_raw: null })
          }
        } else {
          dados.slots = slots
          // Se cliente pediu hora específica mas não tem → avisa e mostra próximos
          const temHorarioExato = dados.hora_raw && slots.some(s => s.hora_iso === dados.hora_raw)
          const podeBuscarOutro = !temHorarioExato && dados.hora_raw && !!dados.barbeiro_id
          dados._pode_buscar_outro = podeBuscarOutro
          let msgSlots = !temHorarioExato && dados.hora_raw
            ? MSG.horario_indisponivel(slots, podeBuscarOutro)
            : MSG.mostra_horarios(slots)
          if (dados._sem_horario_hoje) {
            dados._sem_horario_hoje = false
            // Guarda os slots de amanhã para usar se cliente confirmar
            dados._slots_amanha = slots
            await enviar(conversa, MSG.sem_horario_hoje(dados.barbeiro_nome || 'este barbeiro', dados.unidade_nome || 'sua unidade'))
            await setEstado(conversa.id, 'aguardando_opcao_sem_horario', dados)
            return
          }
          await enviar(conversa, msgSlots)
          await setEstado(conversa.id, 'escolhendo_horario', dados)
        }
      } else {
        await erroOuEscalar(conversa, dados, MSG.nao_entendeu)
      }
      return
    }

    // ── ESTADO: aguardando_opcao_sem_horario
    if (estado === 'aguardando_opcao_sem_horario') {
      const msg = mensagemCliente.toLowerCase()

      // Cliente quer amanhã com o mesmo barbeiro
      if (/amanha|amanhã|sim|pode|quero|ok|claro/.test(msg) && !/outro/.test(msg)) {
        const slots = dados._slots_amanha || []
        if (slots.length > 0) {
          dados.slots = slots
          dados._slots_amanha = null
          await enviar(conversa, MSG.mostra_horarios(slots))
          await setEstado(conversa.id, 'escolhendo_horario', dados)
        } else {
          await enviar(conversa, MSG.sem_horarios)
          await setEstado(conversa.id, 'aguardando_data', { ...dados, data_raw: null })
        }
        return
      }

      // Cliente quer outro barbeiro hoje
      if (/outro|outr|hoje/.test(msg)) {
        const hoje = new Date().toISOString().slice(0,10)
        const dadosHoje = { ...dados, data_raw: hoje, barbeiro_id: null, barbeiro_raw: null }
        const slotsHoje = await buscarOutrosBarbeirosNoHorario({ ...dadosHoje, hora_raw: null })
        // Busca todos os slots de hoje com outros barbeiros
        const { data: cols } = await supabaseAdmin.from('colaboradores')
          .select('id,nome').eq('ativo', true)
          .eq('unidade_id', dados.unidade_id).neq('id', dados.barbeiro_id || '00000000-0000-0000-0000-000000000000')
        if (cols && cols.length > 0) {
          const slotsOutros = await buscarSlots({ ...dadosHoje, barbeiro_id: cols[0].id, data_raw: hoje })
          if (slotsOutros && slotsOutros.length > 0) {
            dados.slots = slotsOutros
            await enviar(conversa, `Encontrei esses horários ainda hoje:\n\n` + MSG.mostra_horarios(slotsOutros).split('\n').slice(1).join('\n'))
            await setEstado(conversa.id, 'escolhendo_horario', dados)
            return
          }
        }
        await enviar(conversa, `Infelizmente não há mais horários hoje com nenhum barbeiro 😔 Quer marcar para amanhã?`)
        return
      }

      // Não entendeu
      await erroOuEscalar(conversa, dados, `Responda *amanhã* para ver horários de amanhã com o ${dados.barbeiro_nome || 'mesmo barbeiro'}, ou *outro barbeiro* para ver disponibilidade hoje 😊`)
      return
    }

    // ── ESTADO: escolhendo_horario
    if (estado === 'escolhendo_horario') {
      const slots = dados.slots || []

      // Detecta se cliente quer ver outro barbeiro no mesmo horário
      const msg = mensagemCliente.toLowerCase()
      const querOutroBarbeiro = dados._pode_buscar_outro && (
        msg.includes('outro barbeiro') || msg.includes('outro barb') ||
        msg.includes('qualquer barbeiro') || msg.includes('outro') ||
        msg.includes('sim') && msg.includes('outro') ||
        msg.includes('ver outro') || msg.includes('busca outro')
      )

      if (querOutroBarbeiro) {
        const outrosSlots = await buscarOutrosBarbeirosNoHorario(dados)
        if (outrosSlots.length > 0) {
          dados.slots = outrosSlots
          dados._pode_buscar_outro = false
          await enviar(conversa,
            `Encontrei esses barbeiros disponíveis às ${dados.hora_raw}:\n\n` +
            outrosSlots.map((s,i) => `${i+1}. ${s.label}`).join('\n') +
            `\n\nQual prefere?`
          )
          await setEstado(conversa.id, 'escolhendo_horario', dados)
        } else {
          await enviar(conversa, `Infelizmente nenhum barbeiro tem disponível esse horário 😔 Quer tentar outro horário?`)
          await setEstado(conversa.id, 'aguardando_data', { ...dados, hora_raw: null, data_raw: null })
        }
        return
      }

      // Escolhe por número
      const ext = await extrairTudo(mensagemCliente)
      const idx  = (ext.numero_escolhido || 1) - 1
      if (idx >= 0 && idx < slots.length) {
        const slot = slots[idx]
        dados.slot_escolhido = slot
        dados.barbeiro_id    = slot.colaborador_id
        dados.barbeiro_nome  = slot.barbeiro_nome
        dados.data_fmt       = slot.data_fmt
        dados.hora_fmt       = slot.hora_fmt
        dados._erros = 0
        await enviar(conversa, MSG.confirma_agendamento(dados))
        await setEstado(conversa.id, 'confirmando', dados)
      } else {
        await erroOuEscalar(conversa, dados, `Escolha um número entre 1 e ${slots.length} 😊`)
      }
      return
    }

    // ── ESTADO: confirmando
    if (estado === 'confirmando') {
      const ext = await extrairTudo(mensagemCliente)
      if (ext.confirmou === true) {
        // Tenta fazer o agendamento
        const ok = await fazerAgendamento(conversa, dados)
        if (ok) {
          await enviar(conversa, MSG.agendado(dados))
          await setEstado(conversa.id, 'agendado', dados)
        } else {
          await escalarHumano(conversa, `Tive um problema ao confirmar o agendamento 😔 Vou chamar um atendente!`)
        }
      } else if (ext.confirmou === false || ext.cancelou) {
        await enviar(conversa, MSG.cancelado)
        await setEstado(conversa.id, 'inicial', {})
      } else {
        await erroOuEscalar(conversa, dados, `Responda *sim* para confirmar ou *não* para cancelar 😊`)
      }
      return
    }

    // ── ESTADO: agendado → conversa encerrada
    if (estado === 'agendado') {
      // Silencioso — não responde automaticamente após agendado
      return
    }

  } catch (e) {
    console.error('[whatsapp/fluxo]', e.message)
    await escalarHumano(conversa, `Tive um problema técnico 😔 Vou chamar um atendente!`)
  }
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
async function setEstado(id, estado, dados) {
  await supabaseAdmin.from('whatsapp_conversas').update({ estado_ia: estado, dados_ia: dados }).eq('id', id)
}

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
