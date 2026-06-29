const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { validarSenhaAutorizacao } = require('../middleware/autorizacao')

// Normaliza a forma de pagamento para os valores que o banco aceita.
function normalizarForma(f) {
  const s = String(f || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (s.includes('din')) return 'dinheiro'
  if (s.includes('cred')) return 'credito'
  if (s.includes('deb')) return 'debito'
  if (s.includes('pix')) return 'pix'
  return 'dinheiro'
}

// Pagamento dividido: [{forma,valor}] só com 2+ formas (valor>0) cuja soma bate
// com o total (±5 centavos). Senão devolve null = forma única (comportamento atual).
function montarPagamentos(pagamentos, totalEsperado) {
  if (!Array.isArray(pagamentos)) return null
  const linhas = pagamentos
    .map(p => ({ forma: normalizarForma(p && p.forma), valor: Math.round((Number(p && p.valor) || 0) * 100) / 100 }))
    .filter(p => p.valor > 0)
  if (linhas.length < 2) return null
  const soma = Math.round(linhas.reduce((s, p) => s + p.valor, 0) * 100) / 100
  if (Math.abs(soma - Number(totalEsperado || 0)) > 0.05) return null
  return linhas
}
function formaPrincipalDe(pags, fallback) {
  if (!pags || !pags.length) return normalizarForma(fallback)
  return pags.reduce((a, b) => (b.valor > a.valor ? b : a)).forma
}

// GET /comandas?unidade_id=xxx&data=2025-05-15&status=aberta
router.get('/', autenticar, exigirPerfil('proprietario','gerente','colaborador','caixa'), async (req, res) => {
  try {
    const { unidade_id, data, status } = req.query
    const u = req.usuario

    // À prova de login antigo: se o token veio SEM unidade, busca a do
    // colaborador no banco (igual o Dashboard faz). Sem isso o caixa/gerente
    // com token velho não enxerga as próprias comandas.
    let unidadeUsuario = u.unidade_id
    if (!unidadeUsuario && u.id && u.perfil !== 'proprietario' && u.perfil !== 'cliente') {
      const { data: col } = await supabaseAdmin
        .from('colaboradores').select('unidade_id').eq('id', u.id).single()
      if (col && col.unidade_id) unidadeUsuario = col.unidade_id
    }

    let query = supabaseAdmin
      .from('comandas')
      .select(`
        id, status, subtotal, desconto, total, forma_pgto, aberta_em, finalizada_em, observacao, colaborador_id, cliente_nome,
        clientes(nome, whatsapp),
        colaboradores!colaborador_id(id, nome)
      `)
      .order('aberta_em', { ascending: false })

    if (status)     query = query.eq('status', status)
    if (unidade_id) {
      query = query.eq('unidade_id', unidade_id)
    } else if (u.perfil !== 'proprietario') {
      // Sem unidade resolvida, não filtra por uuid vazio (isso dá erro no banco):
      // devolve lista vazia, sem quebrar.
      if (!unidadeUsuario) return res.json([])
      query = query.eq('unidade_id', unidadeUsuario)
    }

    if (data) {
      const ini = new Date(data + 'T00:00:00-03:00').toISOString()
      const fim = new Date(data + 'T23:59:59-03:00').toISOString()
      query = query.gte('aberta_em', ini).lte('aberta_em', fim)
    }

    if (u.perfil === 'colaborador') query = query.eq('colaborador_id', u.id)

    const { data: rows, error } = await query
    if (error) throw error
    return res.json(rows)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar comandas: ' + String((err && err.message) || err) })
  }
})

// GET /comandas/aberta-do-agendamento/:agendamento_id
// Recupera a comanda ABERTA de um agendamento (já com os itens salvos), se existir.
// Base da "comanda aberta": ao clicar no agendamento, carrega o que já foi salvo.
router.get('/aberta-do-agendamento/:agendamento_id', autenticar, async (req, res) => {
  try {
    const { agendamento_id } = req.params
    const { data: rows } = await supabaseAdmin
      .from('comandas')
      .select('*, itens_comanda(*)')
      .eq('agendamento_id', agendamento_id)
      .eq('status', 'aberta')
      .order('aberta_em', { ascending: false })
      .limit(1)
    const comanda = (rows && rows[0]) || null
    return res.json({ comanda })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar comanda aberta do agendamento' })
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
        colaboradores!colaborador_id(id, nome),
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

// POST /comandas/:id/corrigir-forma — troca a forma de pagamento de uma comanda
// JÁ finalizada, direto pelo id (serve pra qualquer comanda, inclusive avulsa).
// Gestor logado autoriza sozinho; caixa precisa da senha de autorização.
router.post('/:id/corrigir-forma', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    const raw = String(req.body.forma || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    let forma = null
    if (raw.includes('din')) forma = 'dinheiro'
    else if (raw.includes('cred')) forma = 'credito'
    else if (raw.includes('deb')) forma = 'debito'
    else if (raw.includes('pix')) forma = 'pix'
    if (!forma) return res.status(400).json({ erro: 'Forma inválida. Use dinheiro, débito, crédito ou pix.' })

    let autorizador = null
    if (['gerente', 'proprietario'].includes(req.usuario.perfil)) {
      autorizador = { id: req.usuario.id, nome: req.usuario.nome }
    } else {
      autorizador = await validarSenhaAutorizacao(req.body.senha)
      if (!autorizador) return res.status(403).json({ erro: 'Senha de autorização inválida.' })
    }

    const { data, error } = await supabaseAdmin
      .from('comandas')
      .update({ forma_pgto: forma })
      .eq('id', req.params.id)
      .eq('status', 'finalizada')
      .select('id, total, forma_pgto')
    if (error) throw error
    if (!data || !data.length) return res.status(404).json({ erro: 'Comanda finalizada não encontrada.' })
    return res.json({ ok: true, forma: forma, comanda: data[0], autorizado_por: autorizador.nome })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao corrigir forma de pagamento' })
  }
})

// POST /comandas/:id/estornar — estorna/exclui uma comanda lançada errada.
// Tira do caixa e do faturamento. Gestor autoriza sozinho; caixa precisa de senha.
router.post('/:id/estornar', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    let autorizador = null
    if (['gerente', 'proprietario'].includes(req.usuario.perfil)) {
      autorizador = { id: req.usuario.id, nome: req.usuario.nome }
    } else {
      autorizador = await validarSenhaAutorizacao(req.body.senha)
      if (!autorizador) return res.status(403).json({ erro: 'Senha de autorização inválida.' })
    }

    const { data: cmd, error: e1 } = await supabaseAdmin
      .from('comandas').select('id, agendamento_id').eq('id', req.params.id).single()
    if (e1 || !cmd) return res.status(404).json({ erro: 'Comanda não encontrada.' })

    const { error: e2 } = await supabaseAdmin.from('comandas').delete().eq('id', req.params.id)
    if (e2) throw e2

    // Se a comanda estava ligada a um atendimento e NÃO sobrou outra comanda
    // para ele, devolve o atendimento para "agendado" (sai do faturamento e
    // pode ser refinalizado). Se for duplicata (outra comanda existe), só remove.
    if (cmd.agendamento_id) {
      const { data: outras } = await supabaseAdmin
        .from('comandas').select('id').eq('agendamento_id', cmd.agendamento_id).limit(1)
      if (!outras || !outras.length) {
        await supabaseAdmin.from('agendamentos').update({ status: 'agendado' }).eq('id', cmd.agendamento_id)
      }
    }
    return res.json({ ok: true, estornado_por: autorizador.nome })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao estornar comanda' })
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
    const { cliente_id, forma_pagamento, desconto = 0, itens, colaborador_id } = req.body
    if (!forma_pagamento) return res.status(400).json({ erro: 'forma_pagamento é obrigatório' })
    if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Adicione pelo menos um item' })

    // #1 — cada produto comissionado (barbearia) precisa do barbeiro NO ITEM.
    const prodIds = itens.filter(i => i && i.tipo === 'produto' && i.id).map(i => i.id)
    if (prodIds.length) {
      const { data: prods } = await supabaseAdmin
        .from('produtos').select('id, categorias_produto(paga_comissao)').in('id', prodIds)
      const comissSet = new Set((prods || []).filter(p => p.categorias_produto && p.categorias_produto.paga_comissao).map(p => p.id))
      const faltando = itens.some(i => i && i.tipo === 'produto' && comissSet.has(i.id) && !i.colaborador_id)
      if (faltando) return res.status(400).json({ erro: 'Informe o barbeiro de cada produto de barbearia.' })
    }

    const { data: comanda, error: errC } = await supabaseAdmin
      .from('comandas')
      .insert({ agendamento_id: null, cliente_id: cliente_id || null, colaborador_id: colaborador_id || req.usuario.id, unidade_id: req.usuario.unidade_id, aberta_em: new Date().toISOString(), observacao: 'Comanda avulsa', criado_por: req.usuario.id })
      .select().single()
    if (errC) throw errC

    let subtotal = 0
    const produtosVendidos = []
    for (const it of itens) {
      const tipo = it.tipo === 'produto' ? 'produto' : (it.tipo === 'plano' ? 'plano' : 'servico')
      const qtd  = parseInt(it.quantidade) || 1
      // valor editado no widget (cobrar mais/menos/zerar); se não veio, usa o de tabela
      const valorCustom = (it.valor !== undefined && it.valor !== null && !isNaN(parseFloat(it.valor))) ? parseFloat(it.valor) : null
      let descricao, valor_unit, servico_id = null, produto_id = null, fichaBar = false
      if (tipo === 'servico' || tipo === 'plano') {
        const { data: s } = await supabaseAdmin.from('servicos').select('nome, valor').eq('id', it.id).single()
        if (!s) { await supabaseAdmin.from('comandas').delete().eq('id', comanda.id); return res.status(404).json({ erro: 'Serviço não encontrado' }) }
        descricao = s.nome; valor_unit = valorCustom != null ? valorCustom : s.valor; servico_id = it.id
      } else {
        const { data: p } = await supabaseAdmin.from('produtos').select('nome, valor_venda, categorias_produto(paga_comissao)').eq('id', it.id).single()
        if (!p) { await supabaseAdmin.from('comandas').delete().eq('id', comanda.id); return res.status(404).json({ erro: 'Produto não encontrado' }) }
        descricao = p.nome; produto_id = it.id
        const ehBar = !!(p.categorias_produto && p.categorias_produto.paga_comissao === false)
        if (it.ficha && ehBar) { valor_unit = Math.max(0, parseFloat(p.valor_venda || 0) - 8); fichaBar = true }
        else { valor_unit = valorCustom != null ? valorCustom : p.valor_venda }
        produtosVendidos.push({ produto_id, quantidade: qtd })
      }
      subtotal += parseFloat(valor_unit) * qtd
      await supabaseAdmin.from('itens_comanda').insert({ comanda_id: comanda.id, tipo, servico_id, produto_id, descricao, quantidade: qtd, valor_unit, colaborador_id: (it.colaborador_id || null), ficha_bar: fichaBar })
    }

    const total = Math.max(0, subtotal - parseFloat(desconto || 0))
    const pagsAvulsa = montarPagamentos(req.body.pagamentos, total)
    const { data: fin, error: errF } = await supabaseAdmin
      .from('comandas')
      .update({ status: 'finalizada', forma_pgto: formaPrincipalDe(pagsAvulsa, forma_pagamento), pagamentos: pagsAvulsa, desconto, subtotal, total, finalizada_em: new Date().toISOString() })
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
    const { tipo, servico_id, produto_id, quantidade = 1, colaborador_id, ficha } = req.body
    const comanda_id = req.params.id

    let descricao, valor_unit, ficha_bar = false

    if (tipo === 'servico' && servico_id) {
      const { data: s } = await supabaseAdmin.from('servicos').select('nome, valor').eq('id', servico_id).single()
      if (!s) return res.status(404).json({ erro: 'Serviço não encontrado' })
      descricao  = s.nome
      valor_unit = s.valor
    } else if (tipo === 'produto' && produto_id) {
      const { data: p } = await supabaseAdmin.from('produtos')
        .select('nome, valor_venda, categorias_produto(paga_comissao)').eq('id', produto_id).single()
      if (!p) return res.status(404).json({ erro: 'Produto não encontrado' })
      descricao  = p.nome
      valor_unit = p.valor_venda
      // Ficha de bar: só vale para produto de BAR (categoria que NÃO paga comissão).
      // Cada ficha cobre até R$8 (≤8 zera; >8 desconta 8 e paga a diferença).
      const ehBar = !!(p.categorias_produto && p.categorias_produto.paga_comissao === false)
      if (ficha && ehBar) {
        valor_unit = Math.max(0, parseFloat(p.valor_venda || 0) - 8)
        ficha_bar = true
      }
    } else {
      return res.status(400).json({ erro: 'tipo inválido ou id ausente' })
    }

    const { data, error } = await supabaseAdmin
      .from('itens_comanda')
      .insert({ comanda_id, tipo, servico_id: servico_id || null, produto_id: produto_id || null, descricao, quantidade, valor_unit, colaborador_id: colaborador_id || null, ficha_bar })
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

// PATCH /comandas/:id/itens/:item_id — editar valor e/ou nome do item
// (permite cobrar mais, menos ou zerar; o total da comanda recalcula sozinho)
router.patch('/:id/itens/:item_id', autenticar, async (req, res) => {
  try {
    const patch = {}
    if (req.body.valor_unit !== undefined && req.body.valor_unit !== null) {
      const v = parseFloat(req.body.valor_unit)
      if (isNaN(v) || v < 0) return res.status(400).json({ erro: 'Valor inválido' })
      patch.valor_unit = v
    }
    if (req.body.quantidade !== undefined && req.body.quantidade !== null) {
      const q = parseInt(req.body.quantidade)
      if (isNaN(q) || q < 1) return res.status(400).json({ erro: 'Quantidade inválida' })
      patch.quantidade = q
    }
    if (typeof req.body.descricao === 'string' && req.body.descricao.trim()) {
      patch.descricao = req.body.descricao.trim()
    }
    if (req.body.tipo === 'plano' || req.body.tipo === 'servico') {
      patch.tipo = req.body.tipo
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ erro: 'Nada para atualizar' })
    }
    const { data, error } = await supabaseAdmin
      .from('itens_comanda').update(patch)
      .eq('id', req.params.item_id).eq('comanda_id', req.params.id)
      .select()
      .single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar item' })
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
    const pagsFin  = montarPagamentos(req.body.pagamentos, total)

    const { data, error } = await supabaseAdmin
      .from('comandas')
      .update({ status: 'finalizada', forma_pgto: formaPrincipalDe(pagsFin, forma_pgto), pagamentos: pagsFin, desconto, subtotal, total, finalizada_em: new Date().toISOString() })
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
