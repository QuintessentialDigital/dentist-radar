import postmark from 'postmark';

const token = process.env.POSTMARK_TOKEN;
const from = process.env.POSTMARK_FROM || 'no-reply@example.com';
const sender = process.env.SENDER_NAME || 'Dentist Radar Team';

let pm = null;
if (token) pm = new postmark.ServerClient(token);

export async function sendEmail(to, subject, text){
  if (pm){
    return pm.sendEmail({ From: `${sender} <${from}>`, To: to, Subject: subject, TextBody: text });
  } else {
    console.log('[EMAIL MOCK]', {to, subject, text});
    return { mocked: true };
  }
}

export async function sendWelcome(to){
  const subject = 'Welcome to Dentist Radar';
  const text = [
    'Thanks for creating your NHS dentist availability alert!',
    '',
    'What happens next:',
    '• We monitor public NHS pages for your area(s).',
    '• When a practice appears to accept new NHS patients, we email you immediately.',
    '• Always call the practice to confirm before travelling.',
    '',
    'Tips:',
    '• Pro plan supports up to 5 postcodes and faster checks.',
    '',
    '— Dentist Radar'
  ].join('\n');
  return sendEmail(to, subject, text);
}
