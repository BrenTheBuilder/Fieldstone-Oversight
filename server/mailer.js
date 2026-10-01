// Resend over plain fetch. Returns { ok } and never logs links or tokens.
export function createMailer({ apiKey, from, fetchImpl = fetch }) {
  return {
    configured: Boolean(apiKey && from),
    async send({ to, subject, text, html }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    },
  };
}
