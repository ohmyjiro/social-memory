# Social Memory Product Brief

작성일: 2026-09-13  
단계: 제품 가설 및 아키텍처 설계

## 제품 한 문장

이미 ChatGPT, Claude 또는 Codex를 구독하는 사람이 별도 AI 요금을 내지 않고, 여러 SNS에서 저장한 자료를 로컬 지식으로 축적해 자신이 쓰는 LLM에서 다시 활용하게 하는 오픈소스 브리지.

## 현재 범위

- macOS 우선 로컬 서비스
- X와 Threads 선택형 커넥터
- 좋아요, 저장, 리포스트 수집
- 좋아요(`like`), 저장/북마크(`save`), 리포스트(`repost`)를 별도 Capture로 보존하고 계정별로 수집 종류 선택
- 텍스트, 링크, 이미지, PDF 등 원본 Evidence 보존
- SQLite 기반 중복 제거, 검색, 수집 상태 관리
- Claude Code/Codex Skill 및 로컬 MCP
- 일정 기반 수집과 상태 진단

## 제외 범위

- 네이티브 데스크톱 앱
- 자체 범용 RAG 엔진 연구
- 자체 유료 LLM
- 모든 SNS 동시 지원
- 초기 팀·기업 기능

세부 설계와 시장 판단은 내부 HTML 문서를 기준으로 검토한다.
