# Gravei v2.04-probe

Aplicativo web para registrar e guardar replays diretamente no navegador.

## Publicação no GitHub Pages

1. Crie um repositório novo no GitHub.
2. Envie os cinco arquivos deste pacote para a raiz da branch `main`:
   - `index.html`
   - `icon-gravei-1024.png`
   - `gravei-watch-artwork-512.png`
   - `.nojekyll`
   - `README.md`
3. No repositório, abra **Settings > Pages**.
4. Em **Build and deployment**, selecione **Deploy from a branch**.
5. Escolha a branch `main`, pasta `/ (root)`, e salve.
6. Aguarde o endereço publicado pelo GitHub.

O endereço normalmente será:

`https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/?v=2.03`

## Teste experimental do botão Play

Abra a versão publicada com `?watchplay=1&diag=1&v=2.04`. Sem `watchplay=1`, o comportamento aprovado da v2.03 permanece ativo.

## Observações importantes

- Não renomeie `icon-gravei-1024.png` nem `gravei-watch-artwork-512.png`; o HTML faz referência a esses nomes.
- A câmera exige HTTPS. O GitHub Pages fornece HTTPS automaticamente.
- Captura, cofre, galeria e processamento dos replays ficam no aparelho do usuário.
- Google Fonts é carregado pela internet. Se falhar, o app utiliza as fontes de fallback.
- O controle por outro celular carrega PeerJS pela internet e, por natureza, precisa de conexão.
- O controle pelo relógio usa os controles de mídia do aparelho, sem aplicativo adicional. Ao voltar da Central, ele é retomado automaticamente se já estava ativo.
- Não é necessário compilar, instalar dependências ou executar um processo de build.

## Versão

`v2.04-probe`