// A minimal SMTP server for tests. Speaks enough of RFC 5321 for nodemailer
// to complete a real session, so the mail path is exercised end to end rather
// than stubbed out.

import net from 'node:net';

export function startMockSmtp() {
  const received = [];

  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let mode = 'command';
      let dataBuffer = '';
      let envelope = { from: null, to: [] };

      socket.write('220 mock.smtp.test ESMTP ready\r\n');

      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8');

        if (mode === 'data') {
          dataBuffer += text;
          const end = dataBuffer.indexOf('\r\n.\r\n');
          if (end !== -1) {
            const message = dataBuffer.slice(0, end);
            received.push({
              from: envelope.from,
              to: [...envelope.to],
              raw: message,
              subject: decodeHeader(message, 'Subject'),
              body: message.slice(message.indexOf('\r\n\r\n') + 4),
            });
            dataBuffer = '';
            envelope = { from: null, to: [] };
            mode = 'command';
            socket.write('250 2.0.0 Ok: queued\r\n');
          }
          return;
        }

        for (const line of text.split('\r\n').filter(Boolean)) {
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-mock.smtp.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
          } else if (upper.startsWith('AUTH')) {
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (upper.startsWith('MAIL FROM')) {
            envelope.from = extractAddress(line);
            socket.write('250 2.1.0 Ok\r\n');
          } else if (upper.startsWith('RCPT TO')) {
            envelope.to.push(extractAddress(line));
            socket.write('250 2.1.5 Ok\r\n');
          } else if (upper.startsWith('DATA')) {
            mode = 'data';
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper.startsWith('QUIT')) {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else if (upper.startsWith('RSET')) {
            envelope = { from: null, to: [] };
            socket.write('250 2.0.0 Ok\r\n');
          } else {
            socket.write('250 2.0.0 Ok\r\n');
          }
        }
      });

      socket.on('error', () => {});
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, received, server });
    });
  });
}

function extractAddress(line) {
  const m = line.match(/<([^>]*)>/);
  return m ? m[1] : line.split(':').slice(1).join(':').trim();
}

function decodeHeader(message, name) {
  const m = message.match(new RegExp(`^${name}:\\s*(.*(?:\\r\\n[ \\t].*)*)`, 'im'));
  if (!m) return '';
  let value = m[1].replace(/\r\n[ \t]/g, '');
  // Undo RFC 2047 encoded-words so assertions can read the subject.
  return value.replace(/=\?[^?]+\?B\?([^?]+)\?=/gi, (_, b64) =>
    Buffer.from(b64, 'base64').toString('utf8')
  ).replace(/=\?[^?]+\?Q\?([^?]+)\?=/gi, (_, q) =>
    q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, hex) => String.fromCharCode(parseInt(hex, 16)))
  );
}
