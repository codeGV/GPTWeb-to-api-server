import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SocketModule } from './socket/socket.module';
import { ScheduleModule } from '@nestjs/schedule';
import { StreamMiddleware } from './common/middlewares/stream.middleware';
import { OpenAiController } from './openai/openai.controller';

@Module({
  imports: [SocketModule, ScheduleModule.forRoot()],
  // OpenAiController must come first so its routes win over AppController's wildcards
  controllers: [OpenAiController, AppController],
  providers: [
    AppService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(StreamMiddleware).forRoutes(AppController);
  }
}
