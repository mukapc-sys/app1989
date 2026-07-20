// ============================================================
// routes/push-pro.js — PUSH para COLABORADORES (app PRO)
//
// Reaproveita a mesma infra do push do cliente:
//   - chaves VAPID em env (VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT)
//   - a MESMA tabela push_inscricoes (agora com coluna colaborador_id)
//   - a mesma lib web-push
//
// A inscrição do barbeiro vai com colaborador_id preenchido (cliente_id NULL).
// O envio para um barbeiro filtra por colaborador_id.
//
// Mount no server.js:  app.use('/push', require('./routes/push-pro'))
// Rotas resultantes:    GET /push/chave, POST /push/inscrever, /push/remover, /push/teste
// ============================================================
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar } = require('../middleware/auth')

// web-push com proteção (se a lib/chaves não existirem, o push fica desligado sem quebrar o app)
let webpush = null
try {
  webpush = require('web-push')
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:contato@barbearia1989.com.br',
      process.env.VAPID_PUBLIC,
      process.env.VAPID_PRIVATE
    )
    console.log('[push-pro] web-push configurado')
  } else {
    console.warn('[push-pro] VAPID_PUBLIC/PRIVATE não definidos — push do PRO desligado')
  }
} catch (e) {
  console.warn('[push-pro] biblioteca web-push indisponível:', e.message)
}

// ------------------------------------------------------------
// Envia push para TODAS as inscrições ativas de um colaborador (todos os aparelhos dele).
// Retorna {enviados, falhas}. Desativa endpoints mortos (404/410).
// Exportada para os gatilhos de agendamento (Fase 2).
// ------------------------------------------------------------
async function enviarPushParaColaborador(colaborador_id, payload) {
  if (!webpush || !process.env.VAPID_PUBLIC || !colaborador_id) return { enviados: 0, falhas: 0 }
  const { data: subs, error } = await supabaseAdmin
    .from('push_inscricoes')
    .select('endpoint, p256dh, auth')
    .eq('colaborador_id', colaborador_id)
    .eq('ativo', true)
  if (error || !subs || !subs.length) return { enviados: 0, falhas: 0 }
  const corpo = JSON.stringify(payload || {})
  let enviados = 0, falhas = 0
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, corpo)
      enviados++
    } catch (err) {
      falhas++
      // 404/410 = inscrição morta (o barbeiro desinstalou/limpou) → desativa
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { await supabaseAdmin.from('push_inscricoes').update({ ativo: false }).eq('endpoint', s.endpoint) } catch (_e) {}
      }
    }
  }
  return { enviados, falhas }
}

// GET /push/chave — chave pública VAPID (mesma do cliente). Sem auth (é pública).
router.get('/chave', (_req, res) => {
  if (!process.env.VAPID_PUBLIC) return res.status(503).json({ erro: 'Push não configurado' })
  res.json({ publicKey: process.env.VAPID_PUBLIC })
})

// POST /push/inscrever — salva a inscrição do BARBEIRO logado
router.post('/inscrever', autenticar, async (req, res) => {
  try {
    const sub = (req.body && req.body.subscription) ? req.body.subscription : req.body
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ erro: 'Inscrição inválida' })
    }
    const { error } = await supabaseAdmin.from('push_inscricoes').upsert({
      colaborador_id: req.usuario.id,
      cliente_id:     null,
      endpoint:       sub.endpoint,
      p256dh:         sub.keys.p256dh,
      auth:           sub.keys.auth,
      user_agent:     String(req.headers['user-agent'] || '').slice(0, 300),
      ativo:          true,
    }, { onConflict: 'endpoint' })
    if (error) throw error
    res.json({ ok: true })
  } catch (e) {
    console.error('[push-pro/inscrever]', e.message)
    res.status(500).json({ erro: 'Erro ao salvar inscrição' })
  }
})

// POST /push/remover — desativa a inscrição (barbeiro desligou as notificações)
router.post('/remover', autenticar, async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint
    if (endpoint) {
      await supabaseAdmin.from('push_inscricoes')
        .update({ ativo: false }).eq('endpoint', endpoint).eq('colaborador_id', req.usuario.id)
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('[push-pro/remover]', e.message)
    res.status(500).json({ erro: 'Erro ao remover' })
  }
})

// POST /push/teste — manda um push de teste para o próprio barbeiro (confere a canalização)
router.post('/teste', autenticar, async (req, res) => {
  try {
    if (!webpush || !process.env.VAPID_PUBLIC) return res.status(503).json({ erro: 'Push não configurado' })
    const r = await enviarPushParaColaborador(req.usuario.id, {
      titulo: '🔔 Notificações ativadas',
      corpo:  'Tudo certo! Você vai receber aqui os novos agendamentos de hoje.',
      url:    '/app1989-dashboard',
      tag:    'teste-pro'
    })
    if (!r.enviados) return res.status(404).json({ erro: 'Nenhum aparelho inscrito. Ative as notificações primeiro.' })
    res.json({ ok: true, enviados: r.enviados })
  } catch (e) {
    console.error('[push-pro/teste]', e.message)
    res.status(500).json({ erro: 'Erro ao enviar teste' })
  }
})

module.exports = router
module.exports.enviarPushParaColaborador = enviarPushParaColaborador
