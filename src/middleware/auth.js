const jwt = require('jsonwebtoken')
const { supabaseAdmin } = require('../config/supabase')

// Perfis fixos originais do sistema. Perfis novos (criados pelo proprietário)
// têm um "base" que aponta para um destes — e herdam as permissões dele.
const PERFIS_FIXOS = ['proprietario', 'gerente', 'caixa', 'colaborador', 'funcionario', 'cliente']

// cache simples de perfil->base (evita consultar toda requisição)
let _baseCache = {}
let _baseCacheAt = 0
async function resolverBase(perfil) {
  if (!perfil) return perfil
  if (PERFIS_FIXOS.includes(perfil)) return perfil
  const agora = Date.now()
  if (agora - _baseCacheAt > 60000) {
    try {
      const { data } = await supabaseAdmin.from('perfis_acesso').select('chave, base')
      _baseCache = {}
      ;(data || []).forEach(p => { _baseCache[p.chave] = p.base })
      _baseCacheAt = agora
    } catch (e) { /* mantém cache antigo */ }
  }
  return _baseCache[perfil] || 'colaborador' // fallback seguro: menor privilégio
}

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

    // Resolve o perfil BASE (perfis novos herdam de um fixo). Retrocompatível:
    // perfil fixo -> base = ele mesmo.
    req.usuario.perfil_base = await resolverBase(req.usuario.perfil)

    next()
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' })
  }
}

// Garante que o usuário tem um dos perfis permitidos.
// Aceita tanto o perfil quanto o perfil_base (para perfis novos herdarem).
const exigirPerfil = (...perfisPermitidos) => {
  return (req, res, next) => {
    const p = req.usuario.perfil
    const b = req.usuario.perfil_base
    if (!perfisPermitidos.includes(p) && !perfisPermitidos.includes(b)) {
      return res.status(403).json({
        erro: 'Acesso negado',
        mensagem: `Perfil "${p}" não tem permissão para esta ação`
      })
    }
    next()
  }
}

module.exports = { autenticar, exigirPerfil, resolverBase, PERFIS_FIXOS }
