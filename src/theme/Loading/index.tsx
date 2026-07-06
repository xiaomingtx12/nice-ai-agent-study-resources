import type {ReactNode} from 'react';
import {RouteProgress} from '../../components/RouteProgress';

type LoadingProps = {
  error?: Error;
  retry?: () => void;
  pastDelay?: boolean;
  timedOut?: boolean;
};

export default function Loading({error, retry, pastDelay}: LoadingProps): ReactNode {
  if (error) {
    return (
      <div
        style={{
          textAlign: 'center',
          padding: '2rem',
        }}>
        <p>页面加载失败：{String(error)}</p>
        {retry ? (
          <button type="button" onClick={retry}>
            重试
          </button>
        ) : null}
      </div>
    );
  }

  if (pastDelay) {
    return <RouteProgress />;
  }

  return null;
}
