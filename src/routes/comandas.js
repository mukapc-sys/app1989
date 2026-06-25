const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

// GET /comandas?unidade_id=xxx&data=2025-05-15&status=aberta
router.get('/', autenticar, exigirPerfil('proprietario','gerente','colaborador','caixa'), async (req, res) => {
  try {
    const { unidade_id, data, status } = req.query
    const u = req.usuario

    let query = supabaseAdmin
      .from('comandas')
      .select(`
        id, status, subtotal, desconto, total, forma_pgto, aberta_em, finalizada_em, observacao, colaborador_id,
        clientes(nome, whatsapp),
        colaboradores(id, nome, comissao_pct)
      `)
      .order('aberta_em', { ascending: false })

    if (status)     query = query.eq('status', status)
    if (unidade_id) query = query.eq('unidade_id', unidade_id)
    else if (u.perfil !== 'proprietario') query = query.eq('unidade_id', u.unidade_id)

    if (data) {
      const ini = new Date(data + 'T00:00:00').toISOString()
      const fim = new Date(data + 'T23:59:59').toISOString()
      query = query.gte('aberta_em', ini).lte('aberta_em', fim)
    }

    if (u.perfil === 'colaborador') query = query.eq('colaborador_id', u.id)

    const { data: rows, error } = await query
    if (error) throw error
    return res.json(rows)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar comandas' })
  }
})

// GET /comandas/:id
router.get('/:id', autenticar, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('comandas')
      .select(`
        *, 
        clientes(id, nome, whatsapp),
        colaboradores(id, nome),
        unidades(id, nome),
        itens_comanda(*)
      `)
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Comanda não encontrada' })
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar comanda' })
  }
})

// POST /comandas — abrir nova comanda
router.post('/', autenticar, exigirPerfil('proprietario','gerente','colaborador','caixa'), async (req, res) => {
  try {
    const { agendamento_id, cliente_id, colaborador_id, unidade_id, observacao } = req.body

    const { data, error } = await supabaseAdmin
      .from('comandas')
      .insert({
        agendamento_id: agendamento_id || null,
        cliente_id:     cliente_id || null,
        colaborador_id: colaborador_id || req.usuario.id,
        unidade_id:     unidade_id || req.usuario.unidade_id,
        observacao:     observacao || null,
        criado_por:     req.usuario.id
      })
      .select()
      .single()

    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao abrir comanda' })
  }
})

// POST /comandas/avulsa — cria e finaliza uma comanda numa única ação (venda no balcão, sem agendamento)
router.post('/avulsa', autenticar, exigirPerfil('proprietario','gerente','colaborador','caixa'), async (req, res) => {
  try {
    const { cliente_id, forma_pagamento, desconto = 0, itens } = req.body
    if (!forma_pagamento) return res.status(400).json({ erro: 'forma_pagamento é obrigatório' })
    if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Adicione pelo menos um item' })

    const { data: comanda, error: errC } = await supabaseAdmin
      .from('comandas')
      .insert({ agendamento_id: null, cliente_id: cliente_id || null, colaborador_id: req.usuario.id, unidade_id: req.usuario.unidade_id, observacao: 'Comanda avulsa', criado_por: req.usuario.id })
      .select().single()
    if (errC) throw errC

    let subtotal = 0
    const produtosVendidos = []
    for (const it of itens) {
      const tipo = it.tipo === 'produto' ? 'produto' : 'servico'
      const qtd  = parseInt(it.quantidade) || 1
      let descricao, valor_unit, servico_id = null, produto_id = null
      if (tipo === 'servico') {
        const { data: s } = await supabaseAdmin.from('servicos').select('nome, valor').eq('id', it.id).single()
        if (!s) { await supabaseAdmin.from('comandas').delete().eq('id', comanda.id); return res.status(404).json({ erro: 'Serviço não encontrado' }) }
        descricao = s.nome; valor_unit = s.valor; servico_id = it.id
      } else {
        const { data: p } = await supabaseAdmin.from('produtos').select('nome, valor_venda').eq('id', it.id).single()
        if (!p) { await supabaseAdmin.from('comandas').delete().eq('id', comanda.id); return res.status(404).json({ erro: 'Produto não encontrado' }) }
        descricao = p.nome; valor_unit = p.valor_venda; produto_id = it.id
        produtosVendidos.push({ produto_id, quantidade: qtd })
      }
      subtotal += parseFloat(valor_unit) * qtd
      await supabaseAdmin.from('itens_comanda').insert({ comanda_id: comanda.id, tipo, servico_id, produto_id, descricao, quantidade: qtd, valor_unit })
    }

    const total = Math.max(0, subtotal - parseFloat(desconto || 0))
    const { data: fin, error: errF } = await supabaseAdmin
      .from('comandas')
      .update({ status: 'finalizada', forma_pgto: forma_pagamento, desconto, subtotal, total, finalizada_em: new Date().toISOString() })
      .eq('id', comanda.id).select().single()
    if (errF) throw errF

    for (const pv of produtosVendidos) {
      await supabaseAdmin.from('movimentacoes_estoque').insert({ produto_id: pv.produto_id, unidade_id: fin.unidade_id, tipo: 'saida_venda', quantidade: pv.quantidade, responsavel_id: fin.colaborador_id, referencia_id: comanda.id })
    }
    return res.status(201).json(fin)
  } catch (err) {
    console.error('[comandas/avulsa]', err.message)
    return res.status(500).json({ erro: 'Erro ao registrar comanda avulsa' })
  }
})

// POST /comandas/:id/itens — adicionar serviço ou produto
router.post('/:id/itens', autenticar, async (req, res) => {
  try {
    const { tipo, servico_id, produto_id, quantidade = 1 } = req.body
    const comanda_id = req.params.id

    let descricao, valor_unit

    if (tipo === 'servico' && servico_id) {
      const { data: s } = await supabaseAdmin.from('servicos').select('nome, valor').eq('id', servico_id).single()
      if (!s) return res.status(404).json({ erro: 'Serviço não encontrado' })
      descricao  = s.nome
      valor_unit = s.valor
    } else if (tipo === 'produto' && produto_id) {
      const { data: p } = await supabaseAdmin.from('produtos').select('nome, valor_venda').eq('id', produto_id).single()
      if (!p) return res.status(404).json({ erro: 'Produto não encontrado' })
      descricao  = p.nome
      valor_unit = p.valor_venda
    } else {
      return res.status(400).json({ erro: 'tipo inválido ou id ausente' })
    }

    const { data, error } = await supabaseAdmin
      .from('itens_comanda')
      .insert({ comanda_id, tipo, servico_id: servico_id || null, produto_id: produto_id || null, descricao, quantidade, valor_unit })
      .select()
      .single()

    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao adicionar item' })
  }
})

// DELETE /comandas/:id/itens/:item_id
router.delete('/:id/itens/:item_id', autenticar, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('itens_comanda').delete()
      .eq('id', req.params.item_id).eq('comanda_id', req.params.id)
    if (error) throw error
    return res.json({ mensagem: 'Item removido' })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao remover item' })
  }
})

// PUT /comandas/:id/finalizar
router.put('/:id/finalizar', autenticar, async (req, res) => {
  try {
    const { forma_pgto, desconto = 0 } = req.body
    const { id } = req.params

    if (!forma_pgto) return res.status(400).json({ erro: 'forma_pgto é obrigatório' })

    // Recalcula total com desconto
    const { data: itens } = await supabaseAdmin
      .from('itens_comanda').select('valor_unit, quantidade').eq('comanda_id', id)

    const subtotal = (itens || []).reduce((s, i) => s + (parseFloat(i.valor_unit)||0) * (parseInt(i.quantidade)||1), 0)
    const total    = Math.max(0, subtotal - parseFloat(desconto))

    const { data, error } = await supabaseAdmin
      .from('comandas')
      .update({ status: 'finalizada', forma_pgto, desconto, subtotal, total, finalizada_em: new Date().toISOString() })
      .eq('id', id).select().single()

    if (error) throw error

    // Registra saída de estoque para produtos
    const { data: prodItens } = await supabaseAdmin
      .from('itens_comanda').select('produto_id, quantidade').eq('comanda_id', id).eq('tipo', 'produto').not('produto_id', 'is', null)

    for (const item of (prodItens || [])) {
      await supabaseAdmin.from('movimentacoes_estoque').insert({
        produto_id:     item.produto_id,
        unidade_id:     data.unidade_id,
        tipo:           'saida_venda',
        quantidade:     item.quantidade,
        responsavel_id: data.colaborador_id,
        referencia_id:  id
      })
    }

    return res.json(data)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao finalizar comanda' })
  }
})

module.exports = router
