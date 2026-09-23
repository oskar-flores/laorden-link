import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { enviarCodigo } from '../src/lib/correo.js';

/** Doble del binding de Cloudflare Email Service. NINGUNA prueba manda correo de verdad. */
function espia({ falla = false } = {}) {
  const enviados = [];
  return {
    enviados,
    send: async (mensaje) => {
      if (falla) throw new Error('el servicio de correo ha dicho que no');
      enviados.push(mensaje);
      return { messageId: 'id-de-pruebas' };
    }
  };
}

const VARS = { EMAIL_REMITENTE: 'votacion@laorden.org', CODIGO_MINUTOS: '10' };

describe('enviarCodigo', () => {
  it('manda el código al destinatario y devuelve true', async () => {
    const EMAIL = espia();
    const ok = await enviarCodigo({ ...env, ...VARS, EMAIL }, 'Fulano.Perez@Gmail.com', '123456');

    expect(ok).toBe(true);
    expect(EMAIL.enviados).toHaveLength(1);
    const m = EMAIL.enviados[0];
    // Se manda a la dirección TAL CUAL la escribió la persona (§6.3), no a la normalizada.
    expect(m.to).toBe('Fulano.Perez@Gmail.com');
    expect(m.from.email).toBe('votacion@laorden.org');
    expect(m.subject).toContain('código');
    expect(m.text).toContain('123456');
    expect(m.html).toContain('123456');
    expect(m.text).toContain('10 minutos');
  });

  // Fallar cerrado (§7), igual que se trata hoy IP_SALT.
  it('devuelve false si no hay binding, sin lanzar', async () => {
    expect(await enviarCodigo({ ...env, ...VARS }, 'a@b.com', '123456')).toBe(false);
    expect(await enviarCodigo({ ...env, ...VARS, EMAIL: {} }, 'a@b.com', '123456')).toBe(false);
  });

  it('devuelve false si falta EMAIL_REMITENTE', async () => {
    const EMAIL = espia();
    expect(await enviarCodigo({ ...env, CODIGO_MINUTOS: '10', EMAIL }, 'a@b.com', '123456')).toBe(false);
    expect(EMAIL.enviados).toHaveLength(0);
  });

  it('devuelve false si el servicio lanza, sin propagar la excepción', async () => {
    const EMAIL = espia({ falla: true });
    expect(await enviarCodigo({ ...env, ...VARS, EMAIL }, 'a@b.com', '123456')).toBe(false);
  });

  it('nunca mete el código en el asunto — se ve en la notificación del móvil', async () => {
    const EMAIL = espia();
    await enviarCodigo({ ...env, ...VARS, EMAIL }, 'a@b.com', '123456');
    expect(EMAIL.enviados[0].subject).not.toContain('123456');
  });
});
