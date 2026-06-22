const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

const ADM = ['proprietario', 'gerente']

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

module.exports = router
