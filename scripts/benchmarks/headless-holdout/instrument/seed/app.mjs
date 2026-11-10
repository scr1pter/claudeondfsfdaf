import { createServer } from 'node:http';
const index = process.argv.indexOf('--port');
const server = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 501, {'content-type':'application/json'});
  response.end(JSON.stringify(request.url === '/health' ? {ok:true} : {error:{code:'NOT_IMPLEMENTED',message:'Implement BUILD_SPEC.md'}}));
});
server.listen(Number(index < 0 ? process.env.PORT || 0 : process.argv[index + 1]), '127.0.0.1', () => console.log(JSON.stringify({ready:true,port:server.address().port})));
