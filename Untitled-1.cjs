const net = require('net');

const server = net.createServer((socket) => {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;
    const started = Date.now();

    console.log(`[${id}] CONNECT`);

    const timer = setInterval(() => {
        console.log(
            `[${id}] ${Math.floor((Date.now() - started) / 1000)}s`
        );
    }, 1000);

    function cleanup(reason) {
        clearInterval(timer);
        console.log(
            `[${id}] ${reason} after ${Math.floor((Date.now() - started) / 1000)
            }s`
        );
    }

    socket.on('data', (buf) => {
        console.log(`[${id}] DATA ${buf.length}`);
    });

    socket.on('end', () => {
        console.log(`[${id}] END`);
    });

    socket.on('close', (hadError) => {
        cleanup(`CLOSE (error=${hadError})`);
    });

    socket.on('error', (err) => {
        console.log(`[${id}] ERROR`, err.code);
    });

    socket.on('timeout', () => {
        console.log(`[${id}] TIMEOUT`);
    });

    socket.on('finish', () => {
        console.log(`[${id}] FINISH`);
    });
});

server.listen(8080, () => {
    console.log('listening');
});