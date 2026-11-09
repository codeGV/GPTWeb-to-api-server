import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import { AppModule } from './app.module';

export const PORT = process.env.PORT || 3000;

const chromeId = 'lppnphjckpnmekbjlciagcebgjempohh';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.enableCors(
    process.env.NODE_ENV === 'dev'
      ? {
          origin: true,
        }
      : {
          origin: [`chrome-extension://${chromeId}`],
          credentials: true,
        },
  );

  await app.listen(PORT, () => {
    console.log('Server started on: ', PORT);
    console.log('API URL: ', `http://localhost:${PORT}/`);
  });
}
bootstrap();
