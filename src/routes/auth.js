const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { supabaseAdmin } = require('../config/supabase')

// POST /auth/login
// Recebe email/telefone + senha, retorna JWT com perfil
router.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body
    if (!email || !senha) {
      return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' })
    }

    // Tenta login via Supabase Auth
    const { supabase } = require('../config/supabase')
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase().trim(),
      password: senha
    })

    if (authError) {
      return res.status(401).json({ erro: 'E-mail ou senha incorretos' })
    }

    const userId = authData.user.id

    // Busca perfil — primeiro em colaboradores, depois em clientes
    let usuario = null
    let perfil = null

    const { data: colab } = await supabaseAdmin
      .from('colaboradores')
      .select('id, nome, perfil, unidade_id, foto_url')
      .eq('user_id', userId)
      .eq('ativo', true)
      .single()

    if (colab) {
      usuario = colab
      perfil = colab.perfil
    } else {
      const { data: cliente } = await supabaseAdmin
        .from('clientes')
        .select('id, nome, whatsapp, foto_url')
        .eq('user_id', userId)
        .eq('ativo', true)
        .single()

      if (cliente) {
        usuario = cliente
        perfil = 'cliente'
      }
    }

    if (!usuario) {
      return res.status(401).json({ erro: 'Usuário não encontrado ou inativo' })
    }

    // Colaboradores (barbeiro/gerente/caixa/proprietário) ficam conectados por
    // 15 dias no celular do balcão. Clientes seguem com validade curta (12h)
    // por segurança — o app deles é público.
    const validade = perfil === 'cliente' ? '12h' : '15d'

    // Gera JWT com dados do usuário
    const token = jwt.sign(
      {
        id:         usuario.id,
        user_id:    userId,
        nome:       usuario.nome,
        perfil:     perfil,
        unidade_id: usuario.unidade_id || null
      },
      process.env.JWT_SECRET,
      { expiresIn: validade }
    )

    return res.json({
      token,
      usuario: {
        id:         usuario.id,
        nome:       usuario.nome,
        perfil,
        unidade_id: usuario.unidade_id || null,
        foto_url:   usuario.foto_url || null
      }
    })
  } catch (err) {
    console.error('Erro no login:', err)
    return res.status(500).json({ erro: 'Erro interno do servidor' })
  }
})

// POST /auth/cadastro-cliente
// Apenas clientes podem se cadastrar — colaboradores são cadastrados pelo ADM
router.post('/cadastro-cliente', async (req, res) => {
  try {
    const { nome, email, whatsapp, cpf, data_nasc, senha } = req.body
    if (!nome || !email || !senha || !whatsapp) {
      return res.status(400).json({ erro: 'Nome, e-mail, WhatsApp e senha são obrigatórios' })
    }

    // Cria usuário no Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password: senha,
      email_confirm: true
    })

    if (authError) {
      if (authError.message.includes('already registered')) {
        return res.status(409).json({ erro: 'E-mail já cadastrado' })
      }
      throw authError
    }

    // Cria registro na tabela clientes
    const { data: cliente, error: clienteError } = await supabaseAdmin
      .from('clientes')
      .insert({
        user_id:   authData.user.id,
        nome:      nome.trim(),
        email:     email.toLowerCase().trim(),
        whatsapp:  whatsapp.replace(/\D/g, ''),
        cpf:       cpf ? cpf.replace(/\D/g, '') : null,
        data_nasc: data_nasc || null
      })
      .select()
      .single()

    if (clienteError) throw clienteError

    const token = jwt.sign(
      { id: cliente.id, user_id: authData.user.id, nome: cliente.nome, perfil: 'cliente' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    )

    return res.status(201).json({
      token,
      usuario: { id: cliente.id, nome: cliente.nome, perfil: 'cliente' }
    })
  } catch (err) {
    console.error('Erro no cadastro:', err)
    return res.status(500).json({ erro: 'Erro ao criar cadastro' })
  }
})

// POST /auth/esqueci-senha
router.post('/esqueci-senha', async (req, res) => {
  try {
    const { email } = req.body
    const { supabase } = require('../config/supabase')
    await supabase.auth.resetPasswordForEmail(email)
    // Sempre retorna sucesso (não revela se o e-mail existe)
    return res.json({ mensagem: 'Se o e-mail existir, você receberá as instruções.' })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao processar solicitação' })
  }
})

module.exports = router
