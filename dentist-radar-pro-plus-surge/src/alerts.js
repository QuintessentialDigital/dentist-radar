import Twilio from 'twilio';
import postmark from 'postmark';

const twilioSid = process.env.TWILIO_ACCOUNT_SID;
const twilioToken = process.env.TWILIO_AUTH_TOKEN;
const twilioFromWhatsApp = process.env.TWILIO_FROM_WHATSAPP;
const twilioFromSms = process.env.TWILIO_FROM_SMS;

const pmToken = process.env.POSTMARK_TOKEN;
const pmFrom = process.env.POSTMARK_FROM;

let twilioClient = null;
if (twilioSid && twilioToken) twilioClient = new Twilio(twilioSid, twilioToken);
let pmClient = null;
if (pmToken) pmClient = new postmark.ServerClient(pmToken);

export async function sendAlerts({ to, message, brand }){
  const results = [];
  const subject = `${brand || 'Dentist Radar'}: opening found`;
  if (to.whatsapp && twilioClient && twilioFromWhatsApp){
    try { const r = await twilioClient.messages.create({ from: twilioFromWhatsApp, to:`whatsapp:${to.whatsapp}`, body: message }); results.push({ channel:'whatsapp', sid:r.sid }); }
    catch(e){ results.push({ channel:'whatsapp', error:e.message }); }
  }
  if (to.sms && twilioClient && twilioFromSms){
    try { const r = await twilioClient.messages.create({ from: twilioFromSms, to:to.sms, body:message }); results.push({ channel:'sms', sid:r.sid }); }
    catch(e){ results.push({ channel:'sms', error:e.message }); }
  }
  if (to.email && pmClient && pmFrom){
    try { const r = await pmClient.sendEmail({ From: pmFrom, To: to.email, Subject: subject, TextBody: message }); results.push({ channel:'email', id:r.MessageID }); }
    catch(e){ results.push({ channel:'email', error:e.message }); }
  }
  if (results.length===0){ console.log('[ALERT]', message); results.push({ channel:'console' }); }
  return results;
}
