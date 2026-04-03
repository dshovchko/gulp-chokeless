/**
 * Represents a single node in the FastQueue linked list.
 * @typeParam T - Type of the stored value.
 */
interface QueueNode<T> {
  value: T;
  next: QueueNode<T> | null;
}

/**
 * A lock-free, O(1) high-performance queue designed to replace slow array.shift() operations.
 * Essential for fast message passing and task scheduling without shifting array indexes.
 * @typeParam T - Type of elements stored in the queue.
 */
export class FastQueue<T> {
  private head: QueueNode<T> | null = null;
  private tail: QueueNode<T> | null = null;
  public length = 0;

  /**
   * Adds an element to the front of the queue.
   * @param value - The value to add.
   */
  unshift(value: T): void {
    const node: QueueNode<T> = {value, next: this.head};
    this.head = node;
    if (this.tail === null) {
      this.tail = node;
    }
    this.length++;
  }

  /**
   * Adds an element to the back of the queue.
   * @param value - The value to add.
   */
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

  /**
   * Removes and returns the element at the front of the queue.
   * Returns undefined if the queue is empty.
   */
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
