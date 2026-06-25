const jwt = require('jsonwebtoken')
const { supabaseAdmin } = require('../config/supabase')

// Verifica token JWT e injeta usuário na requisição
const autenticar = async (req, res, next) => {
  try {
    const auth = req.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ erro: 'Token não fornecido' })
    }

    const token = auth.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.usuario = decoded

    // À prova de login antigo: se o token veio SEM unidade, busca a do
    // colaborador no banco (senão o caixa/gerente não enxerga a própria unidade).
    if (!req.usuario.unidade_id && req.usuario.id && req.usuario.perfil && req.usuario.perfil !== 'cliente') {
      try {
        const { data: col } = await supabaseAdmin
          .from('colaboradores').select('unidade_id').eq('id', req.usuario.id).single()
        if (col && col.unidade_id) req.usuario.unidade_id = col.unidade_id
      } catch (e) { /* se falhar, segue sem unidade */ }
    }

    next()
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' })
  }
}

// Garante que o usuário tem um dos perfis permitidos
const exigirPerfil = (...perfisPermitidos) => {
  return (req, res, next) => {
    if (!perfisPermitidos.includes(req.usuario.perfil)) {
      return res.status(403).json({
        erro: 'Acesso negado',
        mensagem: `Perfil "${req.usuario.perfil}" não tem permissão para esta ação`
      })
    }
    next()
  }
}

module.exports = { autenticar, exigirPerfil }
