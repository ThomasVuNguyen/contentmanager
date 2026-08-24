'use client';

import { FC } from 'react';
import { ImageProps } from 'next/image';

type SafeImageProps = Omit<ImageProps, 'src'> & {
  src: string;
};

const SafeImage: FC<SafeImageProps> = ({
  src,
  alt,
  width,
  height,
  className,
  style,
  onError,
  ...rest
}) => {
  return (
    <img
      src={src}
      alt={alt?.toString() || ''}
      width={typeof width === 'number' ? width : undefined}
      height={typeof height === 'number' ? height : undefined}
      className={className}
      style={style}
      onError={(e) => {
        if (onError) {
          (onError as any)(e);
        } else if (
          e.currentTarget.src &&
          !e.currentTarget.src.endsWith('/no-picture.jpg')
        ) {
          e.currentTarget.src = '/no-picture.jpg';
        }
      }}
      {...rest}
    />
  );
};

export default SafeImage;
