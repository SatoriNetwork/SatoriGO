interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: React.CSSProperties;
}

export function Skeleton({ width = '100%', height = 16, radius, style }: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden
    />
  );
}

export function TokenRowSkeleton() {
  return (
    <div className="token-row" aria-hidden>
      <Skeleton width={38} height={38} radius="50%" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Skeleton width="45%" height={13} />
        <Skeleton width="30%" height={11} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <Skeleton width={70} height={13} />
        <Skeleton width={48} height={11} />
      </div>
    </div>
  );
}
