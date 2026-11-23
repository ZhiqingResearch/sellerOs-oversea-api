import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { PrismaService } from "../../prisma/prisma.service"
import { AuthenticatedUser } from "../types"

const MENU_ADMIN_EMAIL = "tranloan74046@gmail.com"

/** 海外菜单管理只认服务端绑定的指定邮箱，管理员也须满足此条件。 */
@Injectable()
export class InternalAccountGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>()
    const userId = req.user?.id
    if (!userId) throw new UnauthorizedException("未登录")

    const account = await this.prisma.emailAccount.findUnique({
      where: { userId },
      select: { email: true },
    })
    if (account?.email.trim().toLowerCase() !== MENU_ADMIN_EMAIL) {
      throw new ForbiddenException("无权限访问菜单配置")
    }
    return true
  }
}
