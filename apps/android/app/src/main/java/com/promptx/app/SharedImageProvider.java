package com.promptx.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.List;
import java.util.Locale;

public final class SharedImageProvider extends ContentProvider {
  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public String getType(Uri uri) {
    File file = resolveImageFile(uri);
    String fileName = file == null ? "" : file.getName().toLowerCase(Locale.US);
    if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    return "image/png";
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
    File file = resolveImageFile(uri);
    if (file == null || !file.isFile()) {
      return null;
    }

    MatrixCursor cursor = new MatrixCursor(new String[] {
      OpenableColumns.DISPLAY_NAME,
      OpenableColumns.SIZE,
    });
    cursor.addRow(new Object[] {
      file.getName(),
      file.length(),
    });
    return cursor;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    File file = resolveImageFile(uri);
    if (file == null) {
      throw new FileNotFoundException("Shared image not found.");
    }

    if ("r".equals(mode)) {
      if (!file.isFile()) {
        throw new FileNotFoundException("Shared image not found.");
      }
      return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    if (isCaptureUri(uri) && ("w".equals(mode) || "wt".equals(mode) || "rw".equals(mode) || "rwt".equals(mode))) {
      File parent = file.getParentFile();
      if (parent == null || (!parent.exists() && !parent.mkdirs())) {
        throw new FileNotFoundException("Capture directory not found.");
      }
      int accessMode = mode.startsWith("rw")
        ? ParcelFileDescriptor.MODE_READ_WRITE
        : ParcelFileDescriptor.MODE_WRITE_ONLY;
      int openMode = ParcelFileDescriptor.MODE_CREATE | accessMode | ParcelFileDescriptor.MODE_TRUNCATE;
      return ParcelFileDescriptor.open(file, openMode);
    }

    throw new SecurityException("Shared images are read-only.");
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    throw new UnsupportedOperationException("Shared images are read-only.");
  }

  @Override
  public int delete(Uri uri, String selection, String[] selectionArgs) {
    throw new UnsupportedOperationException("Shared images are read-only.");
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
    throw new UnsupportedOperationException("Shared images are read-only.");
  }

  private File resolveImageFile(Uri uri) {
    if (getContext() == null || uri == null) {
      return null;
    }

    List<String> segments = uri.getPathSegments();
    if (segments == null || segments.isEmpty()) {
      return null;
    }

    if (segments.size() == 2 && "capture".equals(segments.get(0))) {
      String fileName = segments.get(1);
      if (!isSafeImageFileName(fileName)) {
        return null;
      }
      File captureDir = new File(getContext().getCacheDir(), "captured-images");
      return new File(captureDir, fileName);
    }

    if (segments.size() != 1) {
      return null;
    }

    String fileName = segments.get(0);
    if (!isSafeImageFileName(fileName)) {
      return null;
    }

    File shareDir = new File(getContext().getCacheDir(), "shared-images");
    return new File(shareDir, fileName);
  }

  private boolean isCaptureUri(Uri uri) {
    List<String> segments = uri == null ? null : uri.getPathSegments();
    return segments != null && segments.size() == 2 && "capture".equals(segments.get(0));
  }

  private boolean isSafeImageFileName(String fileName) {
    if (fileName == null || fileName.isEmpty() || fileName.contains("/") || fileName.contains("..")) {
      return false;
    }
    String lowerFileName = fileName.toLowerCase(Locale.US);
    return lowerFileName.endsWith(".png") || lowerFileName.endsWith(".jpg") || lowerFileName.endsWith(".jpeg");
  }
}
