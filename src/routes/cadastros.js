const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

const ADMIN = exigirPerfil('proprietario', 'gerente')

// ============ UNIDADES ============

router.get('/unidades', autenticar, async (req, res) => {
  try {
    const u = req.usuario
    let query = supabaseAdmin.from('unidades').select('*, horarios_unidade(*)').eq('ativa', true).order('nome')
    if (u.perfil === 'colaborador' || u.perfil === 'caixa') {
      query = query.eq('id', u.unidade_id)
    }
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar unidades' })
  }
})

router.post('/unidades', autenticar, exigirPerfil('proprietario'), async (req, res) => {
  try {
    const { nome, endereco, bairro, cidade, cep, telefone, email, horarios } = req.body
    const { data: unidade, error } = await supabaseAdmin
      .from('unidades').insert({ nome, endereco, bairro, cidade, cep, telefone, email }).select().single()
    if (error) throw error

    if (horarios && Array.isArray(horarios)) {
      const rows = horarios.map(h => ({ ...h, unidade_id: unidade.id }))
      await supabaseAdmin.from('horarios_unidade').insert(rows)
    }
    return res.status(201).json(unidade)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar unidade' })
  }
})

router.put('/unidades/:id', autenticar, exigirPerfil('proprietario'), async (req, res) => {
  try {
    const { horarios, ...campos } = req.body
    const { data, error } = await supabaseAdmin.from('unidades').update(campos).eq('id', req.params.id).select().single()
    if (error) throw error

    if (horarios && Array.isArray(horarios)) {
      await supabaseAdmin.from('horarios_unidade').delete().eq('unidade_id', req.params.id)
      const rows = horarios.map(h => ({ ...h, unidade_id: req.params.id }))
      await supabaseAdmin.from('horarios_unidade').insert(rows)
    }
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar unidade' })
  }
})

// ============ COLABORADORES ============

router.get('/colaboradores', autenticar, async (req, res) => {
  try {
    const { unidade_id } = req.query
    const u = req.usuario
    let query = supabaseAdmin
      .from('colaboradores')
      .select('id, nome, email, whatsapp, perfil, comissao_pct, ativo, foto_url, unidade_id, unidades(nome)')
      .eq('ativo', true).order('nome')

    if (u.perfil === 'proprietario') {
      if (unidade_id) query = query.eq('unidade_id', unidade_id)
    } else {
      query = query.eq('unidade_id', u.unidade_id)
    }
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar colaboradores' })
  }
})

router.post('/colaboradores', autenticar, exigirPerfil('proprietario'), async (req, res) => {
  try {
    const { nome, email, whatsapp, cpf, data_nasc, perfil, unidade_id, comissao_pct, servico_ids, senha_temp, foto_url, foto_url_2 } = req.body

    // Cria user no Auth
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email, password: senha_temp || 'Troque123!', email_confirm: true
    })
    if (authErr) throw authErr

    const { data: colab, error } = await supabaseAdmin
      .from('colaboradores')
      .insert({ user_id: authData.user.id, nome, email, whatsapp, cpf, data_nasc, perfil, unidade_id, comissao_pct, foto_url, foto_url_2 })
      .select().single()
    if (error) throw error

    // Vínculos com serviços
    if (servico_ids?.length) {
      const rows = servico_ids.map(s => ({ colaborador_id: colab.id, servico_id: s }))
      await supabaseAdmin.from('colaborador_servicos').insert(rows)
    }
    return res.status(201).json(colab)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao criar colaborador' })
  }
})

router.put('/colaboradores/:id', autenticar, exigirPerfil('proprietario'), async (req, res) => {
  try {
    const { servico_ids, senha_temp, ...campos } = req.body
    const { data, error } = await supabaseAdmin.from('colaboradores').update(campos).eq('id', req.params.id).select().single()
    if (error) throw error

    if (servico_ids) {
      await supabaseAdmin.from('colaborador_servicos').delete().eq('colaborador_id', req.params.id)
      if (servico_ids.length) {
        const rows = servico_ids.map(s => ({ colaborador_id: req.params.id, servico_id: s }))
        await supabaseAdmin.from('colaborador_servicos').insert(rows)
      }
    }
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar colaborador' })
  }
})

// ============ CLIENTES ============

router.get('/clientes', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    const { busca, unidade_id } = req.query
    let query = supabaseAdmin
      .from('clientes')
      .select('id, nome, email, whatsapp, cpf, ativo, criado_em, colaborador_pref, unidade_pref')
      .eq('ativo', true).order('nome').limit(100)

    if (busca) query = query.or(`nome.ilike.%${busca}%,whatsapp.ilike.%${busca}%,cpf.ilike.%${busca}%`)

    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar clientes' })
  }
})

router.get('/clientes/meu', autenticar, exigirPerfil('cliente'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('clientes')
      .select('*, unidades(nome), colaboradores(nome)')
      .eq('user_id', req.usuario.user_id).single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar dados do cliente' })
  }
})

router.put('/clientes/:id', autenticar, async (req, res) => {
  try {
    const u = req.usuario
    // Cliente só pode editar a si mesmo
    if (u.perfil === 'cliente') {
      const { data: cli } = await supabaseAdmin.from('clientes').select('id').eq('user_id', u.user_id).single()
      if (!cli || cli.id !== req.params.id) return res.status(403).json({ erro: 'Sem permissão' })
    }
    const { data, error } = await supabaseAdmin
      .from('clientes').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar cliente' })
  }
})

// ============ SERVIÇOS ============

router.get('/servicos', autenticar, async (req, res) => {
  try {
    const { colaborador_id } = req.query
    let query = supabaseAdmin.from('servicos').select('*').eq('ativo', true).order('nome')

    if (colaborador_id) {
      const { data: vinculos } = await supabaseAdmin
        .from('colaborador_servicos').select('servico_id').eq('colaborador_id', colaborador_id)
      const ids = (vinculos || []).map(v => v.servico_id)
      if (ids.length) query = query.in('id', ids)
    }
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar serviços' })
  }
})

router.post('/servicos', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('servicos').insert(req.body).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar serviço' })
  }
})

router.put('/servicos/:id', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('servicos').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar serviço' })
  }
})

// ============ PRODUTOS ============

router.get('/produtos', autenticar, async (req, res) => {
  try {
    const { categoria_id } = req.query
    let query = supabaseAdmin.from('produtos').select('*, categorias_produto(nome)').eq('ativo', true).order('nome')
    if (categoria_id) query = query.eq('categoria_id', categoria_id)
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar produtos' })
  }
})

router.get('/produtos/por-barcode/:barcode', autenticar, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('produtos').select('*').eq('barcode', req.params.barcode).single()
    if (error || !data) return res.status(404).json({ erro: 'Produto não encontrado' })
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar produto' })
  }
})

router.post('/produtos', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('produtos').insert(req.body).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar produto' })
  }
})

router.put('/produtos/:id', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('produtos').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar produto' })
  }
})

// ============ ESTOQUE ============

router.post('/estoque/entrada', autenticar, ADMIN, async (req, res) => {
  try {
    const { produto_id, unidade_id, quantidade, valor_unitario, observacao } = req.body
    const { data, error } = await supabaseAdmin
      .from('movimentacoes_estoque')
      .insert({ produto_id, unidade_id, tipo: 'entrada', quantidade, valor_unitario, responsavel_id: req.usuario.id, observacao })
      .select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao registrar entrada' })
  }
})

// ============ PLANOS ============

router.get('/planos', autenticar, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('planos')
      .select('*, plano_servicos(servico_id, limite_mes, servicos(nome, duracao_min))')
      .eq('ativo', true).order('valor_mensal')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar planos' })
  }
})

router.post('/planos', autenticar, exigirPerfil('proprietario'), async (req, res) => {
  try {
    const { servico_ids, ...plano } = req.body
    const { data, error } = await supabaseAdmin.from('planos').insert(plano).select().single()
    if (error) throw error
    if (servico_ids?.length) {
      const rows = servico_ids.map(s => ({ plano_id: data.id, servico_id: s.id, limite_mes: s.limite || null }))
      await supabaseAdmin.from('plano_servicos').insert(rows)
    }
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar plano' })
  }
})

router.get('/assinaturas', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('assinaturas')
      .select('*, clientes(nome, whatsapp), planos(nome, valor_mensal)')
      .order('data_renovacao')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar assinaturas' })
  }
})

router.post('/assinaturas', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('assinaturas').insert(req.body).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar assinatura' })
  }
})

// ============ FERIADOS ============
// Horário especial 09h-18h (igual sábado). Cadastrados por gerente/proprietário.

router.get('/feriados', autenticar, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('feriados').select('*').order('data', { ascending: true })
    if (error) throw error
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao listar feriados' })
  }
})

router.post('/feriados', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, descricao, fechado, hora_abre, hora_fecha } = req.body || {}
    if (!data) return res.status(400).json({ erro: 'Informe a data do feriado' })
    const reg = {
      data,
      descricao: (descricao || '').trim() || null,
      fechado: !!fechado,
      hora_abre:  (!fechado && hora_abre)  ? String(hora_abre).slice(0, 5)  : null,
      hora_fecha: (!fechado && hora_fecha) ? String(hora_fecha).slice(0, 5) : null,
      criado_por: req.usuario.id,
    }
    const { data: novo, error } = await supabaseAdmin
      .from('feriados')
      .upsert(reg, { onConflict: 'data' })
      .select().single()
    if (error) throw error
    return res.status(201).json(novo)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao salvar feriado' })
  }
})

router.delete('/feriados/:id', autenticar, ADMIN, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('feriados').delete().eq('id', req.params.id)
    if (error) throw error
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao excluir feriado' })
  }
})

module.exports = router
