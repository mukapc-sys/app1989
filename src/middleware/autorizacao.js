const bcrypt = require('bcryptjs')
const { supabaseAdmin } = require('../config/supabase')

// Recebe uma senha em texto puro e devolve o gerente/proprietário cuja
// "senha de autorização" confere — ou null se nenhuma bater.
// Compara contra TODOS os gestores ativos que já definiram uma senha.
async function validarSenhaAutorizacao(senha) {
  if (!senha) return null
  const { data: gestores } = await supabaseAdmin
    .from('colaboradores')
    .select('id, nome, perfil, senha_autorizacao')
    .in('perfil', ['gerente', 'proprietario'])
    .eq('ativo', true)
    .not('senha_autorizacao', 'is', null)

  for (const g of (gestores || [])) {
    try {
      if (g.senha_autorizacao && await bcrypt.compare(String(senha), g.senha_autorizacao)) {
        return { id: g.id, nome: g.nome, perfil: g.perfil }
      }
    } catch (e) { /* hash inválido nessa linha — ignora e segue */ }
  }
  return null
}

module.exports = { validarSenhaAutorizacao }
