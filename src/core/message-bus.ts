export type MessageHandler<TMessage> = (message: TMessage) => void | Promise<void>;

export class MessageBus<TMessage> {
  private readonly subscribers = new Set<MessageHandler<TMessage>>();

  subscribe(handler: MessageHandler<TMessage>): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  async publish(message: TMessage): Promise<void> {
    await Promise.all([...this.subscribers].map((handler) => handler(message)));
  }
}
