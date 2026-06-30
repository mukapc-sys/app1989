// ============================================================
// appbarber-raw.js  (CAMINHO PARALELO — não toca em nada existente)
// Recebe da EXTENSÃO NOVA o espelho cru das comandas do AppBarber
// e grava nas tabelas ab_comandas_raw / ab_itens_raw (upsert, sem duplicar).
//
// Montar no servidor principal junto das outras rotas, por ex.:
//   app.use('/appbarber-raw', require('./routes/appbarber-raw'))
// (mesmo lugar onde já existe o app.use('/appbarber', ...))
// ============================================================
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')

// mesmo segredo da extensão atual (header x-ext-segredo)
function segredoOk(req) {
  const s = req.headers['x-ext-segredo'] || (req.body && req.body.segredo)
  return process.env.APPBARBER_EXT_SECRET && s === process.env.APPBARBER_EXT_SECRET
}

// "40,00" / "1.234,56" -> 40.00 / 1234.56 ; aceita também número puro
function parseNum(v) {
  if (v == null || v === '') return 0
  let s = String(v).trim()
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.') // formato BR
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

// "29/06/2026 11:00" -> ISO -03:00 (ou null)
function parseDataHora(s) {
  if (!s) return null
  const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}))?/)
  if (!m) return null
  const [, dd, mm, yyyy, hh = '12', mi = '00'] = m
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00-03:00`
}

// ------------------------------------------------------------
// POST /appbarber-raw/comandas
// body: { unidade_id, comandas: [ {Codigo,Status,DataCadastro,Valor,Cliente,
//         CodigoCliente,Obs,UsuCadastro,UsuFinaliza,DataFinaliza,DataInsercao,
//         Profissional,TipoComanda,TipoPagamento} ] }
// ------------------------------------------------------------
router.post('/comandas', async (req, res) => {
  try {
    if (!segredoOk(req)) return res.status(401).json({ ok: false, motivo: 'SEGREDO_INVALIDO' })
    const { unidade_id, comandas } = req.body || {}
    if (!unidade_id || !Array.isArray(comandas)) {
      return res.status(400).json({ ok: false, erro: 'Envie unidade_id e comandas[]' })
    }

    const linhas = comandas
      .filter(c => c && c.Codigo)
      .map(c => ({
        codigo:            String(c.Codigo),
        unidade_id,
        status:            c.Status || null,
        valor:             parseNum(c.Valor),
        valor_txt:         c.Valor != null ? String(c.Valor) : null,
        cliente:           c.Cliente || null,
        codigo_cliente:    c.CodigoCliente != null ? String(c.CodigoCliente) : null,
        obs:               c.Obs || null,
        usu_cadastro:      c.UsuCadastro || null,
        usu_finaliza:      c.UsuFinaliza || null,
        profissional_nome: c.Profissional || null,
        tipo_comanda:      c.TipoComanda != null ? String(c.TipoComanda) : null,
        tipo_pagamento:    c.TipoPagamento || null,
        data_cadastro_txt: c.DataCadastro || null,
        data_cadastro_ts:  parseDataHora(c.DataCadastro),
        data_finaliza_txt: c.DataFinaliza || null,
        data_insercao_txt: c.DataInsercao || null,
      }))

    let gravados = 0
    if (linhas.length) {
      // grava em blocos pra não estourar payload
      for (let i = 0; i < linhas.length; i += 500) {
        const bloco = linhas.slice(i, i + 500)
        const { error } = await supabaseAdmin
          .from('ab_comandas_raw')
          .upsert(bloco, { onConflict: 'codigo' })
        if (error) throw error
        gravados += bloco.length
      }
    }
    return res.json({ ok: true, gravados })
  } catch (err) {
    console.error('[appbarber-raw/comandas]', err.message)
    return res.status(200).json({ ok: false, motivo: 'ERRO', detalhe: err.message })
  }
})

// ------------------------------------------------------------
// POST /appbarber-raw/itens
// body: { unidade_id, itens: [ {CodItem,ComandaCodigo,TipoItem,Venda,Descricao,
//         Quantidade,ValorUnit,Comissao,ProfissionalCodigo,ClienteCodigo,Data} ] }
// (a extensão já manda com esses nomes "limpos")
// ------------------------------------------------------------
router.post('/itens', async (req, res) => {
  try {
    if (!segredoOk(req)) return res.status(401).json({ ok: false, motivo: 'SEGREDO_INVALIDO' })
    const { unidade_id, itens } = req.body || {}
    if (!unidade_id || !Array.isArray(itens)) {
      return res.status(400).json({ ok: false, erro: 'Envie unidade_id e itens[]' })
    }

    const linhas = itens
      .filter(it => it && it.CodItem)
      .map(it => ({
        cod_item:            String(it.CodItem),
        comanda_codigo:      it.ComandaCodigo != null ? String(it.ComandaCodigo) : null,
        unidade_id,
        tipo_item:           it.TipoItem != null ? String(it.TipoItem) : null,
        venda:               it.Venda != null ? String(it.Venda) : null,
        descricao:           (it.Descricao || '').trim() || null,
        quantidade:          parseNum(it.Quantidade) || 1,
        valor_unit:          parseNum(it.ValorUnit),
        comissao:            parseNum(it.Comissao),
        profissional_codigo: it.ProfissionalCodigo != null ? String(it.ProfissionalCodigo) : null,
        cliente_codigo:      it.ClienteCodigo != null ? String(it.ClienteCodigo) : null,
        data_txt:            it.Data || null,
      }))

    let gravados = 0
    if (linhas.length) {
      for (let i = 0; i < linhas.length; i += 500) {
        const bloco = linhas.slice(i, i + 500)
        const { error } = await supabaseAdmin
          .from('ab_itens_raw')
          .upsert(bloco, { onConflict: 'cod_item' })
        if (error) throw error
        gravados += bloco.length
      }
    }
    return res.json({ ok: true, gravados })
  } catch (err) {
    console.error('[appbarber-raw/itens]', err.message)
    return res.status(200).json({ ok: false, motivo: 'ERRO', detalhe: err.message })
  }
})

// ------------------------------------------------------------
// GET /appbarber-raw/sem-itens?unidade_id=...&limite=400
// Lista códigos de comandas que JÁ estão no espelho de cabeçalho
// mas que AINDA não tiveram os itens puxados. Serve pra Fase 2 (itens)
// rodar em blocos e poder retomar de onde parou.
// Ignora Canceladas (não interessam).
// ------------------------------------------------------------
router.get('/sem-itens', async (req, res) => {
  try {
    if (!segredoOk(req)) return res.status(401).json({ ok: false, motivo: 'SEGREDO_INVALIDO' })
    const unidade_id = req.query.unidade_id
    const limite = Math.min(parseInt(req.query.limite) || 400, 1000)
    if (!unidade_id) return res.status(400).json({ ok: false, erro: 'Envie unidade_id' })

    // pega um lote de comandas da unidade (não canceladas)
    const { data: cab, error: e1 } = await supabaseAdmin
      .from('ab_comandas_raw')
      .select('codigo')
      .eq('unidade_id', unidade_id)
      .neq('status', 'Cancelada')
      .order('data_cadastro_ts', { ascending: false })
      .limit(5000)
    if (e1) throw e1
    const todos = (cab || []).map(r => r.codigo)
    if (!todos.length) return res.json({ ok: true, codigos: [] })

    // quais desses já têm item?
    const comItem = new Set()
    for (let i = 0; i < todos.length; i += 1000) {
      const fatia = todos.slice(i, i + 1000)
      const { data: its, error: e2 } = await supabaseAdmin
        .from('ab_itens_raw')
        .select('comanda_codigo')
        .in('comanda_codigo', fatia)
      if (e2) throw e2
      ;(its || []).forEach(r => comItem.add(String(r.comanda_codigo)))
    }

    const pendentes = todos.filter(c => !comItem.has(String(c))).slice(0, limite)
    return res.json({ ok: true, codigos: pendentes, total_pendentes_no_lote: todos.filter(c => !comItem.has(String(c))).length })
  } catch (err) {
    console.error('[appbarber-raw/sem-itens]', err.message)
    return res.status(200).json({ ok: false, motivo: 'ERRO', detalhe: err.message })
  }
})

module.exports = router
