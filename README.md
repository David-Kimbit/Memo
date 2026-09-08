# 메모함 (Memo Cabinet)

서류철 탭처럼 여러 폴더가 쌓여있고, 각 폴더 아래로 제목/요약이 적힌 탭이 살짝 튀어나와 보이는 메모 앱입니다.

- 폴더를 클릭하면 맨 앞으로 나오면서 열립니다 (여러 페이지로 구성된 긴 문서도 가능).
- 뒤에 쌓인 폴더의 탭에 마우스를 올리면 요약 미리보기가 툴팁으로 뜹니다.
- 데이터는 `%APPDATA%/memo-cabinet/data/notes.json`에 자동 저장됩니다.

## 실행 방법

```bash
npm install
npm start
```

## 설치 파일(exe)로 만들기 (선택)

필요하면 `electron-builder`를 추가해 배포용 exe를 만들 수 있습니다:

```bash
npm install --save-dev electron-builder
npx electron-builder --win
```
