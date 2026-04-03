interface QueueNode<T> {
  value: T;
  next: QueueNode<T> | null;
}

export class FastQueue<T> {
  private head: QueueNode<T> | null = null;
  private tail: QueueNode<T> | null = null;
  public length = 0;

  unshift(value: T): void {
    const node: QueueNode<T> = {value, next: this.head};
    this.head = node;
    if (this.tail === null) {
      this.tail = node;
    }
    this.length++;
  }

  push(value: T): void {
    const node: QueueNode<T> = {value, next: null};
    if (this.tail !== null) {
      this.tail.next = node;
    } else {
      this.head = node;
    }
    this.tail = node;
    this.length++;
  }

  shift(): T | undefined {
    if (this.head === null) return undefined;
    const value = this.head.value;
    this.head = this.head.next;
    if (this.head === null) {
      this.tail = null;
    }
    this.length--;
    return value;
  }
}
