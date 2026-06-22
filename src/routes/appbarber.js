const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { sincronizarUnidade, processarAgendamentos } = require('./appbarber-sync')

const ADM = ['proprietario', 'gerente']

// dd/mm/aaaa de hoje (fuso de São Paulo)
function diaDeHojeBR() {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  const dd = String(agora.getDate()).padStart(2, '0')
  const mm = String(agora.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${agora.getFullYear()}`
}

// ============================================================
// GET /appbarber/depara
// Retorna tudo que a telinha de de-para precisa:
//  - unidades
//  - colaboradores (opções p/ casar profissional) por unidade
//  - serviços do sistema (opções p/ casar serviço)
//  - de-para de profissional e de serviço (com o vínculo atual)
// ============================================================
router.get('/depara', autenticar, exigirPerfil(...ADM), async (req, res) => {
  try {
    const [unidades, colaboradores, servicosSistema, deParaProf, deParaServ] = await Promise.all([
      supabaseAdmin.from('unidades').select('id, nome').order('nome'),
      supabaseAdmin.from('colaboradores').select('id, nome, unidade_id').eq('ativo', true).order('nome'),
      supabaseAdmin.from('servicos').select('id, nome').eq('ativo', true).order('nome'),
      supabaseAdmin.from('appbarber_depara_profissional').select('id, unidade_id, appbarber_id, appbarber_nome, colaborador_id').order('appbarber_nome'),
      supabaseAdmin.from('appbarber_depara_servico').select('id, unidade_id, appbarber_id, appbarber_nome, servico_id').order('appbarber_nome'),
    ])

    for (const r of [unidades, colaboradores, servicosSistema, deParaProf, deParaServ]) {
      if (r.error) throw r.error
    }

    return res.json({
      unidades:            unidades.data,
      colaboradores:       colaboradores.data,
      servicos_sistema:    servicosSistema.data,
      depara_profissional: deParaProf.data,
      depara_servico:      deParaServ.data,
    })
  } catch (err) {
    console.error('[appbarber/depara GET]', err.message)
    return res.status(500).json({ erro: 'Erro ao carregar de-para' })
  }
})

// ============================================================
// PUT /appbarber/depara/profissional/:id  { colaborador_id }
// Liga (ou desliga, se vier null) um profissional do AppBarber a um barbeiro.
// ============================================================
router.put('/depara/profissional/:id', autenticar, exigirPerfil(...ADM), async (req, res) => {
  try {
    const colaborador_id = req.body.colaborador_id || null
    const { data, error } = await supabaseAdmin
      .from('appbarber_depara_profissional')
      .update({ colaborador_id })
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[appbarber/depara prof PUT]', err.message)
    return res.status(500).json({ erro: 'Erro ao salvar vínculo de profissional' })
  }
})

// ============================================================
// PUT /appbarber/depara/servico/:id  { servico_id }
// Liga (ou desliga) um serviço do AppBarber a um serviço do sistema.
// ============================================================
router.put('/depara/servico/:id', autenticar, exigirPerfil(...ADM), async (req, res) => {
  try {
    const servico_id = req.body.servico_id || null
    const { data, error } = await supabaseAdmin
      .from('appbarber_depara_servico')
      .update({ servico_id })
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[appbarber/depara serv PUT]', err.message)
    return res.status(500).json({ erro: 'Erro ao salvar vínculo de serviço' })
  }
})

// ============================================================
// POST /appbarber/ler/:unidade   body opcional: { cookie, dia }
// Dispara UMA leitura da agenda daquela unidade e grava no sistema.
// - cookie: se não vier no body, usa o salvo em appbarber_sessoes
// - dia: 'dd/mm/aaaa' ou 'aaaa-mm-dd'; se não vier, usa hoje
// ============================================================
router.post('/ler/:unidade', autenticar, exigirPerfil(...ADM), async (req, res) => {
  try {
    const unidadeId = req.params.unidade
    let cookie = req.body && req.body.cookie

    if (!cookie) {
      const { data: sessao } = await supabaseAdmin
        .from('appbarber_sessoes').select('cookie').eq('unidade_id', unidadeId).single()
      cookie = sessao && sessao.cookie
    }
    if (!cookie) {
      return res.status(400).json({ erro: 'Sem cookie para esta unidade. Faça a conexão primeiro.' })
    }

    const dia = (req.body && req.body.dia) || diaDeHojeBR()
    const resumo = await sincronizarUnidade(unidadeId, cookie, dia)
    return res.json({ ok: true, resumo })
  } catch (err) {
    console.error('[appbarber/ler]', err.message)
    const motivo = err.message === 'SESSAO_EXPIRADA' ? 'SESSAO_EXPIRADA' : 'ERRO'
    // devolve 200 com ok:false p/ o front conseguir ler o motivo (em vez de quebrar)
    return res.status(200).json({ ok: false, motivo, detalhe: err.message })
  }
})

// ============================================================
// POST /appbarber/sessao   body: { unidade_id, cookie }
// Salva/atualiza o cookie de uma unidade (validade 24h).
// Chamado pela página de captura (atalho/bookmarklet).
// ============================================================
router.post('/sessao', autenticar, exigirPerfil(...ADM), async (req, res) => {
  try {
    const { unidade_id, cookie } = req.body || {}
    if (!unidade_id || !cookie) {
      return res.status(400).json({ erro: 'Informe unidade_id e cookie' })
    }
    const expira_em = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const { error } = await supabaseAdmin
      .from('appbarber_sessoes')
      .upsert({
        unidade_id, cookie, expira_em,
        status: 'conectado',
        atualizado_em: new Date().toISOString(),
      }, { onConflict: 'unidade_id' })
    if (error) throw error
    return res.json({ ok: true, expira_em })
  } catch (err) {
    console.error('[appbarber/sessao]', err.message)
    return res.status(500).json({ erro: 'Erro ao salvar a conexão' })
  }
})

// ============================================================
// GET /appbarber/sessoes
// Lista o status de conexão de cada unidade (p/ a tela).
// ============================================================
router.get('/sessoes', autenticar, exigirPerfil(...ADM), async (req, res) => {
  try {
    const [unidades, sessoes] = await Promise.all([
      supabaseAdmin.from('unidades').select('id, nome').order('nome'),
      supabaseAdmin.from('appbarber_sessoes').select('unidade_id, status, expira_em, atualizado_em'),
    ])
    if (unidades.error) throw unidades.error
    if (sessoes.error) throw sessoes.error

    const porUnidade = {}
    for (const s of sessoes.data) porUnidade[s.unidade_id] = s
    const agora = Date.now()

    const lista = unidades.data.map((u) => {
      const s = porUnidade[u.id]
      let status = 'desconectado'
      if (s && s.expira_em) {
        status = new Date(s.expira_em).getTime() > agora ? 'conectado' : 'expirado'
      }
      return {
        unidade_id: u.id,
        nome: u.nome,
        status,
        expira_em: s ? s.expira_em : null,
        atualizado_em: s ? s.atualizado_em : null,
      }
    })
    return res.json({ sessoes: lista })
  } catch (err) {
    console.error('[appbarber/sessoes]', err.message)
    return res.status(500).json({ erro: 'Erro ao listar conexões' })
  }
})

// ============================================================
// POST /appbarber/importar   (chamado pela EXTENSÃO)
// Recebe os agendamentos JÁ LIDOS no navegador do usuário e processa.
// Protegido por uma senha secreta (header x-ext-segredo), pois a
// extensão não tem o login do sistema.
// body: { unidade_id, agendamentos: [ ...itens crus do AppBarber... ] }
// ============================================================
router.post('/importar', async (req, res) => {
  try {
    const segredo = req.headers['x-ext-segredo'] || (req.body && req.body.segredo)
    if (!process.env.APPBARBER_EXT_SECRET || segredo !== process.env.APPBARBER_EXT_SECRET) {
      return res.status(401).json({ ok: false, motivo: 'SEGREDO_INVALIDO' })
    }
    const { unidade_id, agendamentos } = req.body || {}
    if (!unidade_id || !Array.isArray(agendamentos)) {
      return res.status(400).json({ ok: false, erro: 'Envie unidade_id e agendamentos[]' })
    }
    const resumo = await processarAgendamentos(unidade_id, agendamentos)
    return res.json({ ok: true, resumo: { unidade_id, ...resumo } })
  } catch (err) {
    console.error('[appbarber/importar]', err.message)
    return res.status(200).json({ ok: false, motivo: 'ERRO', detalhe: err.message })
  }
})

module.exports = router
