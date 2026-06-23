require('dotenv').config()
const express = require('express')
const cors    = require('cors')

const app = express()

// ============================================================
// Middlewares globais
// ============================================================
app.use(cors({
  origin: function(origin, callback) {
    // Permite qualquer origem (ou sem origem como Postman)
    callback(null, origin || '*')
  },
  credentials: true
}))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Log de requisições em desenvolvimento
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${req.method} ${req.path}`)
    next()
  })
}

// ============================================================
// Rotas
// ============================================================
app.use('/auth',         require('./routes/auth'))
app.use('/agendamentos', require('./routes/agendamentos'))
app.use('/comandas',     require('./routes/comandas'))
app.use('/financeiro',   require('./routes/financeiro'))
app.use('/relatorios',   require('./routes/financeiro'))
app.use('/assistente',   require('./routes/assistente'))
app.use('/appbarber',    require('./routes/appbarber'))
app.use('/publico',      require('./routes/publico'))
app.use('/',             require('./routes/cadastros'))
app.use('/',             require('./routes/novos'))
app.use('/',             require('./routes/dashboard'))

// Rota de health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    sistema: 'APP 1989',
    versao: '1.0.0',
    timestamp: new Date().toISOString()
  })
})

// Handler de erros
app.use((err, _req, res, _next) => {
  console.error('Erro não tratado:', err)
  res.status(500).json({ erro: 'Erro interno do servidor' })
})

// 404
app.use((_req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada' })
})

// ============================================================
// Jobs agendados (lembretes de WhatsApp)
// ============================================================
const cron = require('node-cron')
const { supabaseAdmin } = require('../config/supabase')

// Todo dia às 8h — envia lembretes do dia seguinte
cron.schedule('0 8 * * *', async () => {
  try {
    console.log('[CRON] Processando lembretes do dia seguinte...')
    const amanha = new Date()
    amanha.setDate(amanha.getDate() + 1)
    const ini = new Date(amanha.setHours(0,0,0,0)).toISOString()
    const fim = new Date(amanha.setHours(23,59,59,999)).toISOString()

    const { data: agendamentos } = await supabaseAdmin
      .from('vw_agenda_dia')
      .select('cliente_nome, cliente_whatsapp, colaborador_nome, servico_nome, data_hora_ini, unidade_nome')
      .gte('data_hora_ini', ini)
      .lte('data_hora_ini', fim)
      .in('status', ['agendado', 'confirmado'])

    for (const ag of (agendamentos || [])) {
      if (!ag.cliente_whatsapp) continue

      const hora  = new Date(ag.data_hora_ini).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const data  = new Date(ag.data_hora_ini).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })
      const msg   = `Olá ${ag.cliente_nome}! 👋\n\nLembrete do seu agendamento *amanhã*:\n\n✂️ *${ag.servico_nome}*\n👤 ${ag.colaborador_nome}\n📍 ${ag.unidade_nome}\n🕐 ${hora} — ${data}\n\nTe esperamos! Caso precise remarcar, responda esta mensagem.`

      await supabaseAdmin.from('notificacoes_whatsapp').insert({
        destinatario: '55' + ag.cliente_whatsapp.replace(/\D/g, ''),
        mensagem:     msg,
        tipo:         'lembrete',
        status:       'pendente'
      })
    }
    console.log(`[CRON] ${(agendamentos || []).length} lembretes enfileirados`)
  } catch (err) {
    console.error('[CRON] Erro ao processar lembretes:', err)
  }
}, { timezone: 'America/Sao_Paulo' })

// A cada 5 min — lembretes por PUSH (≈1h antes e ≈30min antes)
const { enviarPushParaCliente } = require('./routes/publico')
cron.schedule('*/5 * * * *', async () => {
  try {
    const agora = new Date()
    const em30  = new Date(agora.getTime() + 30 * 60000)
    const em60  = new Date(agora.getTime() + 60 * 60000)

    const { data: ags } = await supabaseAdmin.from('agendamentos')
      .select('id, cliente_id, data_hora_ini, unidades(nome)')
      .gt('data_hora_ini', agora.toISOString())
      .lte('data_hora_ini', em60.toISOString())
      .in('status', ['agendado', 'confirmado'])
      .not('cliente_id', 'is', null)
    if (!ags || !ags.length) return

    const ids = ags.map(a => a.id)
    const { data: enviados } = await supabaseAdmin.from('push_lembretes')
      .select('agendamento_id, tipo').in('agendamento_id', ids)
    const jaEnviado = new Set((enviados || []).map(s => s.agendamento_id + '|' + s.tipo))

    for (const a of ags) {
      const dt = new Date(a.data_hora_ini)
      const tipo = dt > em30 ? '1h' : '30m'   // 30–60min antes → "1h"; ≤30min → "30m"
      if (jaEnviado.has(a.id + '|' + tipo)) continue

      // horário de Brasília (UTC-3, sem horário de verão no Brasil)
      const br = new Date(dt.getTime() - 3 * 3600000)
      const hora = String(br.getUTCHours()).padStart(2, '0') + ':' + String(br.getUTCMinutes()).padStart(2, '0')
      const uni = (a.unidades && a.unidades.nome) ? ' na ' + a.unidades.nome : ''
      const quando = tipo === '1h' ? 'daqui a 1 hora' : 'em 30 minutos'

      try {
        await enviarPushParaCliente(a.cliente_id, {
          title: 'Seu horário está chegando ✂️',
          body: `Seu atendimento é ${quando}, às ${hora}${uni}. Até já!`,
          url: 'https://barbearia1989.com.br'
        })
        await supabaseAdmin.from('push_lembretes').insert({ agendamento_id: a.id, tipo })
      } catch (e) { /* falha pontual não derruba o loop */ }
    }
  } catch (err) {
    console.error('[CRON push] erro:', err.message)
  }
}, { timezone: 'America/Sao_Paulo' })

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`\n🪒  APP 1989 Backend rodando na porta ${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/health`)
  console.log(`   Supabase: ${process.env.SUPABASE_URL}\n`)
})

module.exports = app
