const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { sincronizarUnidade, processarAgendamentos, carregarDeParas } = require('./appbarber-sync')

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

// ============================================================
// POST /appbarber/importar-produtos   (chamado pela EXTENSÃO)
// Recebe os PRODUTOS lidos das comandas do AppBarber e grava (upsert por CodItem).
// body: { unidade_id, produtos: [{ item_id, comanda_codigo, descricao, quantidade,
//          valor_unit, comissao, cliente_codigo, profissional_codigo, data }] }
// ============================================================
function parseNumAB(v) {
  if (v == null || v === '') return 0
  let s = String(v).trim()
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.') // formato BR "1.234,56"
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}
function parseDataAB(s) {
  // "23/06/2026 14:30" -> ISO -03:00 ; aceita também já-ISO
  if (!s) return null
  s = String(s).trim()
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}))?/)
  if (m) {
    const [, dd, mm, yyyy, hh = '12', mi = '00'] = m
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00-03:00`
  }
  return s
}

router.post('/importar-produtos', async (req, res) => {
  try {
    const segredo = req.headers['x-ext-segredo'] || (req.body && req.body.segredo)
    if (!process.env.APPBARBER_EXT_SECRET || segredo !== process.env.APPBARBER_EXT_SECRET) {
      return res.status(401).json({ ok: false, motivo: 'SEGREDO_INVALIDO' })
    }
    const { unidade_id, produtos } = req.body || {}
    if (!unidade_id || !Array.isArray(produtos)) {
      return res.status(400).json({ ok: false, erro: 'Envie unidade_id e produtos[]' })
    }

    // mapa profissional AppBarber -> colaborador do sistema (pra atribuir o produto)
    let profMap = {}
    try { const dp = await carregarDeParas(unidade_id); profMap = dp.profMap || {} } catch (e) {}

    const linhas = produtos
      .filter(p => p && p.item_id)
      .map(p => ({
        appbarber_item_id: String(p.item_id),
        comanda_codigo:    p.comanda_codigo != null ? String(p.comanda_codigo) : null,
        unidade_id,
        colaborador_id:    (p.profissional_codigo && profMap[String(p.profissional_codigo)]) || null,
        cliente_codigo:    p.cliente_codigo != null ? String(p.cliente_codigo) : null,
        descricao:         (p.descricao || '').trim() || 'Produto',
        quantidade:        parseInt(p.quantidade) || 1,
        valor_unit:        parseNumAB(p.valor_unit),
        comissao:          parseNumAB(p.comissao),
        data:              parseDataAB(p.data),
      }))

    let gravados = 0
    if (linhas.length) {
      const { error } = await supabaseAdmin
        .from('agenda_appbarber_produtos')
        .upsert(linhas, { onConflict: 'unidade_id,appbarber_item_id' })
      if (error) throw error
      gravados = linhas.length
    }
    return res.json({ ok: true, resumo: { unidade_id, gravados } })
  } catch (err) {
    console.error('[appbarber/importar-produtos]', err.message)
    return res.status(200).json({ ok: false, motivo: 'ERRO', detalhe: err.message })
  }
})

// ============================================================
// POST /appbarber/finalizar/:id   (chamado pela TELA, caixa logado)
// Finaliza um agendamento importado, de 2 formas:
//   onde='novo'      -> cria agendamento concluído + comanda finalizada (entra no caixa)
//   onde='appbarber' -> só marca como concluído (NÃO entra no caixa)
// body: { onde, forma_pgto?, valor? }
// ============================================================
router.post('/finalizar/:id', autenticar, exigirPerfil('proprietario', 'gerente', 'caixa', 'colaborador'), async (req, res) => {
  try {
    const { onde = 'novo', forma_pgto, valor, itens } = req.body || {}

    // 1) carrega o importado
    const { data: ab, error: e0 } = await supabaseAdmin
      .from('agenda_appbarber').select('*').eq('id', req.params.id).single()
    if (e0 || !ab) return res.status(404).json({ erro: 'Agendamento importado não encontrado' })
    if (ab.finalizado) return res.status(400).json({ erro: 'Este atendimento já foi finalizado' })

    const valorFinal = (valor !== undefined && valor !== null && valor !== '') ? Number(valor) : Number(ab.valor || 0)
    const ondeFinal = (onde === 'appbarber') ? 'appbarber' : 'novo'

    // ===== SEMPRE cria o agendamento concluído =====
    // (alimenta faturamento do dashboard, relatórios e COMISSÕES — nos dois casos)
    const { data: ag, error: e1 } = await supabaseAdmin.from('agendamentos').insert({
      data_hora_ini: ab.inicio,
      data_hora_fim: ab.fim,
      status:        'concluido',
      valor:         valorFinal,
      observacao:    ab.observacao || null,
      canal_origem:  'appbarber',
      colaborador_id: ab.colaborador_id,
      unidade_id:    ab.unidade_id,
      cliente_id:    ab.cliente_id,
      servico_id:    ab.servico_id,
      criado_por:    req.usuario.id,
    }).select().single()
    if (e1) throw e1

    // ===== Comanda SÓ no caminho "novo" =====
    // (a comanda é o que entra no FECHAMENTO DE CAIXA; no caminho "appbarber"
    //  o dinheiro já foi recebido lá, então não criamos comanda)
    let comandaId = null
    if (ondeFinal === 'novo') {
      const { data: cm, error: e2 } = await supabaseAdmin.from('comandas').insert({
        agendamento_id: ag.id,
        cliente_id:     ab.cliente_id,
        colaborador_id: ab.colaborador_id,
        unidade_id:     ab.unidade_id,
        status:         'finalizada',
        forma_pgto:     forma_pgto || 'dinheiro',
        subtotal:       valorFinal,
        desconto:       0,
        total:          valorFinal,
        finalizada_em:  new Date().toISOString(),
        criado_por:     req.usuario.id,
        observacao:     'Importado do AppBarber',
      }).select().single()
      if (e2) throw e2
      comandaId = cm.id

      // best-effort: grava os ITENS da comanda (alimenta a comissão por faixa).
      // Não quebra a finalização se falhar.
      try {
        const listaItens = Array.isArray(itens) ? itens : []
        if (listaItens.length) {
          const linhas = listaItens.map(function (it) {
            const q = parseInt(it.quantidade) || 1
            const vu = (it.valor_unit != null) ? Number(it.valor_unit)
                      : (it.valor != null ? Number(it.valor) : 0)
            return {
              comanda_id: comandaId,
              tipo:       it.tipo || 'servico',
              servico_id: it.servico_id || null,
              produto_id: it.produto_id || null,
              descricao:  it.descricao || null,
              quantidade: q,
              valor_unit: vu,
            }
          })
          await supabaseAdmin.from('itens_comanda').insert(linhas)
        }
      } catch (eItens) {
        console.error('[appbarber/finalizar itens]', eItens.message)
      }
    }

    // ===== marca o importado como finalizado e liga aos criados =====
    const { error: e3 } = await supabaseAdmin.from('agenda_appbarber')
      .update({
        finalizado: true,
        finalizado_em: new Date().toISOString(),
        finalizado_onde: ondeFinal,
        agendamento_id: ag.id,
        comanda_id: comandaId,
      })
      .eq('id', ab.id)
    if (e3) throw e3

    return res.json({ ok: true, onde: ondeFinal, agendamento_id: ag.id, comanda_id: comandaId })
  } catch (err) {
    console.error('[appbarber/finalizar]', err.message)
    return res.status(500).json({ erro: 'Erro ao finalizar', detalhe: err.message })
  }
})

module.exports = router
