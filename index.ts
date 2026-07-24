// supabase/functions/send-email/index.ts
//
// Deploy: supabase functions deploy send-email
// Requires a secret: supabase secrets set RESEND_API_KEY=your_resend_key
//
// Once deployed, replace `simulateEmail(...)` calls in app.js with:
//   await sb.functions.invoke('send-email', { body: { to, subject, html } });

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_ADDRESS = "NIHSS Driver Booking <support@databytes.sc>";

serve(async (req) => {
  try {
    const { to, subject, html } = await req.json();
    if (!to || !subject) {
      return new Response(JSON.stringify({ error: "Missing to/subject" }), { status: 400 });
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        subject,
        html: html || `<p>${subject}</p>`,
      }),
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
