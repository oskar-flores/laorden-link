import { describe, it, expect } from 'vitest';
import { normalizarCorreo, correoValido, CORREO_MAX } from '../src/lib/correo-norm.js';

describe('normalizarCorreo', () => {
  it('recorta y pasa a minúsculas siempre', () => {
    expect(normalizarCorreo('  Fulano@Outlook.COM ')).toBe('fulano@outlook.com');
  });

  // La prueba del §13 del spec: las dos formas son el mismo buzón de Gmail.
  it('colapsa puntos y etiquetas + en gmail.com', () => {
    expect(normalizarCorreo('Fulano.Perez+concurso@Gmail.com'))
      .toBe(normalizarCorreo('fulanoperez@gmail.com'));
    expect(normalizarCorreo('Fulano.Perez+concurso@Gmail.com')).toBe('fulanoperez@gmail.com');
  });

  it('aplica la misma regla a googlemail.com', () => {
    expect(normalizarCorreo('f.u.lano+x@googlemail.com')).toBe('fulano@googlemail.com');
  });

  // Y la contraria, que es la que evita fusionar a dos personas distintas.
  it('NO toca puntos ni + en otros dominios', () => {
    expect(normalizarCorreo('a.b@outlook.com')).not.toBe(normalizarCorreo('ab@outlook.com'));
    expect(normalizarCorreo('a.b@outlook.com')).toBe('a.b@outlook.com');
    expect(normalizarCorreo('ana+concurso@empresa.es')).toBe('ana+concurso@empresa.es');
  });

  it('no rompe con entradas absurdas', () => {
    expect(normalizarCorreo(null)).toBe('');
    expect(normalizarCorreo(undefined)).toBe('');
    expect(normalizarCorreo(42)).toBe('');
    expect(normalizarCorreo('')).toBe('');
    expect(normalizarCorreo('sin-arroba')).toBe('sin-arroba');
    expect(normalizarCorreo('@gmail.com')).toBe('@gmail.com');
    expect(normalizarCorreo('fulano@')).toBe('fulano@');
  });

  it('un + que se come el local entero deja el local vacío, no explota', () => {
    expect(normalizarCorreo('+todo@gmail.com')).toBe('@gmail.com');
  });
});

describe('correoValido', () => {
  it('acepta direcciones normales', () => {
    expect(correoValido('fulano@gmail.com')).toBe(true);
    expect(correoValido('a.b+c@sub.dominio.es')).toBe(true);
  });

  it('rechaza lo que no tiene forma de correo', () => {
    expect(correoValido('')).toBe(false);
    expect(correoValido('sin-arroba')).toBe(false);
    expect(correoValido('dos@@arrobas.com')).toBe(false);
    expect(correoValido('sin punto@dominio')).toBe(false);
    expect(correoValido('fulano@sindominio')).toBe(false);
    expect(correoValido('fulano@.com')).toBe(false);
    expect(correoValido(null)).toBe(false);
    expect(correoValido(1234)).toBe(false);
  });

  it('corta en 254 caracteres (RFC 5321)', () => {
    expect(CORREO_MAX).toBe(254);
    const dominio = '@ejemplo.com';                 // 12 caracteres
    const justo = 'a'.repeat(254 - dominio.length) + dominio;
    expect(justo).toHaveLength(254);
    expect(correoValido(justo)).toBe(true);
    expect(correoValido('a' + justo)).toBe(false);
  });
});
