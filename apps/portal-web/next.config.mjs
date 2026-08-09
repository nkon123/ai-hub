// 폐쇄망 전제(CLAUDE.md): Next.js는 기본적으로 익명 사용 통계를 외부
// (telemetry.nextjs.org)로 전송하려 시도한다 — `next telemetry status`로
// Enabled 임을 실측 확인했다. 인터넷이 없는 사내망에서는 매 빌드/기동마다
// 실패하는 무의미한 외부 연결이 되고, 보안 검토 대상이기도 하므로 저장소
// 차원에서 끈다. 여기서 환경변수를 설정하는 이유는 `next telemetry disable`이
// 개발자 홈 디렉터리의 전역 설정에 기록되어 저장소를 복제한 다른 PC에는
// 적용되지 않기 때문이다. 참고: docs/implementation-spec/13-windows-local-setup.md
process.env.NEXT_TELEMETRY_DISABLED = "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8000/api/:path*",
      },
    ];
  },
};

export default nextConfig;
