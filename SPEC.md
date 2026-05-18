# pi-provider-kiro 개선 스펙

## 문제 분석

### 문제 1: Region 매핑 누락으로 모델 목록 빈 배열 반환

**원인 흐름:**
```
사용자 SSO region (예: ap-northeast-2)
  → resolveApiRegion() 에서 API_REGION_MAP 조회
  → 매핑 없으면 원본 region 그대로 반환 ("ap-northeast-2")
  → filterModelsByRegion() 에서 MODELS_BY_REGION["ap-northeast-2"] 조회
  → undefined → 빈 배열 반환 → 모델 0개
```

**핵심**: Kiro API는 `us-east-1`과 `eu-central-1` 두 곳에만 배포됨. 그 외 모든 SSO 리전은 이 둘 중 하나로 매핑되어야 함.

**해결**: `API_REGION_MAP`에 누락 리전 추가 + `resolveApiRegion()` fallback을 `us-east-1`로 변경.

---

### 문제 2: Token Refresh 실패로 반복 로그인 요구

**:**
```
토큰 만료
  → refreshKiroTokenDirect() 호출
  → 리전 매핑 문제로 잘못된 엔드포인트에 리프레시 요청
  → 실패 → 6단계 폴백 체인 전부 실패
  → throw → pi가 loginKiro 호출 → 로그인 페이지 반복 표시
  → 시간 경과 후 refresh token 자체 만료 → kiro-cli 직접 로그인 외 방법 없음
```

**해결**: `refreshKiroTokenDirect` 제거. 토큰 갱신을 kiro-cli에 전임.
- kiro-cli DB에서 유효 토큰 확인만 수행
- 유효 토큰 없으면 throw → pi 프레임워크가 `loginKiro` 호출 → kiro-cli login 실행

---

### 문제 3: 로그인 플로우 불완전

**현재 상태:**
- IAM IdC 선택 시 start URL만 입력받고, region은 10개 리전을 순차 probe하여 자동 감지
- probe 목록(`IDC_PROBE_REGIONS`)에 `ap-northeast-2` 등 일부 리전 누락
- Google/GitHub 로그인은 `kiro-cli`가 PATH에 있어야만 동작

**해결**: probe 목록 확장 + region 수동 입력 지원 + kiro-cli 브라우저 로그인 위임.

---

## 적용 상태

| # | 작업 | 상태 |
|---|------|------|
| 1 | `API_REGION_MAP` 누락 리전 추가 | ✅ 완료 |
| 2 | `resolveApiRegion()` fallback을 us-east-1로 변경 | ✅ 완료 |
| 3 | `refreshKiroTokenDirect` 제거, kiro-cli 전임 | ✅ 완료 |
| 4 | `IDC_PROBE_REGIONS`에 ap-northeast-2 등 추가 | ✅ 완료 |
| 5 | 로그인 TUI에 region 수동 입력 옵션 추가 | ✅ 완료 |
| 6 | kiro-cli 브라우저 로그인 위임 | ✅ 완료 |
